import { prisma, type PrismaClient } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AuditService,
  BoardRepository,
  BoardService,
  ColumnService,
  DomainError,
  SERIALIZATION_FAILURE,
  TaskRepository,
  TaskService,
  TransactionRunner,
  type ActorContext,
  type AuditEvent,
  type AuditTransaction,
  type BoardDetail,
} from "../src/index";
import {
  connectDb,
  contarFilas,
  ctx,
  insertBoard,
  insertColumn,
  insertTask,
  insertTasks,
  porKey,
  truncateAll,
  uuid,
} from "./helpers";

/**
 * La auditoria de la 7.4: que cada escritura deja su registro, que ninguna
 * lectura lo deja, y sobre todo que el registro y la operacion viven o mueren
 * juntos porque comparten transaccion.
 *
 * Las tres pruebas del final son las que justifican todo el diseno, y ninguna
 * asume nada: el fallo del registro se FUERZA (una vez contra la base y otra
 * desde el servicio), y el reintento se FUERZA abortando el primer intento con
 * la misma forma de error que produce una contencion real.
 */

let db: Client;
let tableros: BoardService;
let columnas: ColumnService;
let tareas: TaskService;

beforeAll(async () => {
  db = await connectDb();
  const boards = new BoardRepository(new TransactionRunner(prisma));
  tableros = new BoardService(boards);
  columnas = new ColumnService(boards);
  tareas = new TaskService(new TaskRepository(new TransactionRunner(prisma)));
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- Lectura de la tabla -----------------------------------------------------

interface FilaAuditoria {
  actor_type: string;
  actor_name: string;
  client_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  request_id: string | null;
}

async function auditoria(): Promise<FilaAuditoria[]> {
  const filas = await db.query<FilaAuditoria>(
    `SELECT actor_type, actor_name, client_id, action, entity_type, entity_id,
            before_data, after_data, request_id
       FROM audit_log
      ORDER BY id`,
  );
  return filas.rows;
}

/** El unico registro que la operacion tuvo que dejar. Falla si hay 0 o 2. */
async function unico(): Promise<FilaAuditoria> {
  const filas = await auditoria();
  expect(filas).toHaveLength(1);
  const fila = filas[0];
  if (fila === undefined) {
    throw new Error("inalcanzable: ya se verifico que hay exactamente una fila");
  }
  return fila;
}

async function acciones(): Promise<string[]> {
  return (await auditoria()).map((fila) => `${fila.action} ${fila.entity_type}`);
}

// --- Siembra -----------------------------------------------------------------
//
// Por SQL crudo, igual que el resto de la suite: lo que se audita es lo que
// hacen los servicios, y una siembra que pasara por ellos ensuciaria la tabla
// justo con lo que cada prueba quiere leer.

interface Tablero {
  boardId: string;
  todo: string;
  done: string;
}

async function sembrar(): Promise<Tablero> {
  const boardId = await insertBoard(db, "Personal");
  return {
    boardId,
    todo: await insertColumn(db, { boardId, key: "TODO", position: 0 }),
    done: await insertColumn(db, { boardId, key: "DONE", position: 1 }),
  };
}

async function capturar(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Se esperaba un error, pero la operacion termino bien.");
}

describe("CREATE deja el registro con la entidad completa", () => {
  it("un tablero se registra con sus columnas", async () => {
    const tablero = await tableros.create({ name: "Personal" }, ctx());

    const fila = await unico();
    expect(fila.action).toBe("CREATE");
    expect(fila.entity_type).toBe("board");
    expect(fila.entity_id).toBe(tablero.id);
    expect(fila.before_data).toBeNull();
    expect(fila.after_data?.["name"]).toBe("Personal");
    // Las cuatro columnas por defecto entran en el mismo registro: es una sola
    // operacion y deja un solo evento, no cinco.
    expect((fila.after_data?.["columns"] as unknown[]).length).toBe(4);
  });

  it("una columna se registra con la position que quedo, no con la pedida", async () => {
    const t = await sembrar();

    const columna = await columnas.create(
      { boardId: t.boardId, name: "En revision", key: "REVIEW", position: 99 },
      ctx(),
    );

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual([
      "CREATE",
      "column",
      columna.id,
    ]);
    expect(fila.before_data).toBeNull();
    expect(fila.after_data?.["key"]).toBe("REVIEW");
    expect(fila.after_data?.["position"]).toBe(2);
  });

  it("una tarea se registra entera", async () => {
    const t = await sembrar();

    const tarea = await tareas.create(
      {
        boardId: t.boardId,
        columnId: t.todo,
        title: "Informe",
        description: "Con detalle",
        priority: "URGENT",
        dueDate: new Date("2026-09-11T00:00:00.000Z"),
      },
      ctx(),
    );

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["CREATE", "task", tarea.id]);
    expect(fila.before_data).toBeNull();
    expect(fila.after_data).toMatchObject({
      id: tarea.id,
      board_id: t.boardId,
      column_id: t.todo,
      title: "Informe",
      description: "Con detalle",
      priority: "URGENT",
      due_date: "2026-09-11",
      position: 0,
    });
  });
});

describe("UPDATE registra solo los campos modificados", () => {
  it("con su valor previo y el nuevo", async () => {
    const t = await sembrar();
    const taskId = await insertTask(db, {
      boardId: t.boardId,
      columnId: t.todo,
      title: "Vieja",
      position: 0,
    });

    await tareas.update(taskId, { title: "Nueva", priority: "HIGH" }, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["UPDATE", "task", taskId]);
    // Ni `description` ni `due_date`, que no se tocaron: la 7.4 pide SOLO los
    // campos modificados, y un before con la entidad entera haria imposible
    // saber cual de ellos cambio.
    expect(fila.before_data).toEqual({ title: "Vieja", priority: "MEDIUM" });
    expect(fila.after_data).toEqual({ title: "Nueva", priority: "HIGH" });
  });

  it("un patch sin cambio efectivo no deja registro (5.2)", async () => {
    const t = await sembrar();
    const taskId = await insertTask(db, {
      boardId: t.boardId,
      columnId: t.todo,
      title: "Igual",
      position: 0,
    });

    const tarea = await tareas.update(taskId, { title: "Igual", priority: "MEDIUM" }, ctx());

    expect(tarea.title).toBe("Igual");
    expect(await auditoria()).toEqual([]);
  });

  it("renombrar un tablero registra name y no description", async () => {
    const tablero = await tableros.create({ name: "Viejo", description: "Igual" }, ctx());
    await truncateAudit();

    await tableros.update(tablero.id, { name: "Nuevo", description: "Igual" }, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type]).toEqual(["UPDATE", "board"]);
    expect(fila.before_data).toEqual({ name: "Viejo" });
    expect(fila.after_data).toEqual({ name: "Nuevo" });
  });

  it("reordenar una columna registra su position y no la de sus vecinas", async () => {
    const t = await sembrar();
    const review = await insertColumn(db, { boardId: t.boardId, key: "REVIEW", position: 2 });

    await columnas.update(review, { position: 0 }, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["UPDATE", "column", review]);
    expect(fila.before_data).toEqual({ position: 2 });
    expect(fila.after_data).toEqual({ position: 0 });
  });
});

describe("MOVE registra column_id y position en las dos puntas (7.4)", () => {
  it("un movimiento entre columnas", async () => {
    const t = await sembrar();
    const [, segunda] = await insertTasks(db, {
      boardId: t.boardId,
      columnId: t.todo,
      prefijo: "todo",
      cantidad: 3,
    });
    if (segunda === undefined) {
      throw new Error("la siembra tiene que devolver tres tareas");
    }

    await tareas.move(segunda, { columnId: t.done, position: 0 }, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["MOVE", "task", segunda]);
    expect(fila.before_data).toEqual({ column_id: t.todo, position: 1 });
    expect(fila.after_data).toEqual({ column_id: t.done, position: 0 });
  });

  it("un reordenamiento dentro de la misma columna", async () => {
    const t = await sembrar();
    const [primera] = await insertTasks(db, {
      boardId: t.boardId,
      columnId: t.todo,
      prefijo: "todo",
      cantidad: 3,
    });
    if (primera === undefined) {
      throw new Error("la siembra tiene que devolver tres tareas");
    }

    await tareas.move(primera, { columnId: t.todo, position: 2 }, ctx());

    const fila = await unico();
    expect(fila.action).toBe("MOVE");
    expect(fila.before_data).toEqual({ column_id: t.todo, position: 0 });
    expect(fila.after_data).toEqual({ column_id: t.todo, position: 2 });
  });
});

describe("DELETE deja en before_data lo que se perdio", () => {
  it("una tarea, entera", async () => {
    const t = await sembrar();
    const taskId = await insertTask(db, {
      boardId: t.boardId,
      columnId: t.todo,
      title: "Se va",
      position: 0,
    });

    await tareas.delete(taskId, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["DELETE", "task", taskId]);
    expect(fila.after_data).toBeNull();
    // Lo que importa: el registro alcanza para saber QUE se borro, no solo que
    // algo se borro. Sin el titulo, un DELETE es un id que ya no resuelve.
    expect(fila.before_data).toMatchObject({
      id: taskId,
      title: "Se va",
      column_id: t.todo,
      position: 0,
    });
  });

  it("una columna vacia, sin cesion de tareas", async () => {
    const t = await sembrar();

    await columnas.delete(t.done, {}, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual(["DELETE", "column", t.done]);
    expect(fila.before_data).toMatchObject({ key: "DONE" });
    expect(fila.before_data?.["cascade"]).toEqual({ tasks: 0, reassigned_to: null });
  });

  it("una columna con reassignTo dice cuantas tareas cedio y a quien", async () => {
    const t = await sembrar();
    await insertTasks(db, { boardId: t.boardId, columnId: t.todo, prefijo: "t", cantidad: 2 });

    await columnas.delete(t.todo, { reassignTo: t.done }, ctx());

    const fila = await unico();
    expect(fila.before_data?.["cascade"]).toEqual({ tasks: 2, reassigned_to: t.done });
  });

  it("un tablero, con el recuento (5.2) y los IDS (7.4) de lo que se llevo en cascada", async () => {
    // Siembra propia, con ids FIJOS y DOS columnas, en vez de `sembrar()`: el
    // orden en que la implementacion LEE las tareas es el canonico
    // `(column_id, id)` y el orden en que las REGISTRA es ascendente por id, y
    // este fixture existe para que esos dos ordenes NO puedan coincidir. La
    // columna que va primero al leer lleva el id de tarea mas alto.
    //
    // Con las tres tareas en UNA columna —como estaba antes— los dos ordenes
    // son el mismo para cualquier sorteo de UUID, no por mala suerte sino por
    // construccion, y entonces esta prueba pasa igual aunque el servicio no
    // ordene nada. Medido: sacandole el `.sort()` al servicio, 24 de 24 verdes.
    const columnaQueSeLeePrimero = "00000000-0000-4000-8000-000000000000";
    const columnaQueSeLeeDespues = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const idAlto = "99999999-9999-4999-8999-999999999999";
    const idBajo = "11111111-1111-4111-8111-111111111111";
    const idMedio = "55555555-5555-4555-8555-555555555555";

    const boardId = await insertBoard(db, "Personal");
    await insertColumn(db, { boardId, key: "TODO", position: 0, id: columnaQueSeLeePrimero });
    await insertColumn(db, { boardId, key: "DONE", position: 1, id: columnaQueSeLeeDespues });
    await insertTask(db, {
      boardId,
      columnId: columnaQueSeLeePrimero,
      title: "alta",
      position: 0,
      id: idAlto,
    });
    await insertTask(db, {
      boardId,
      columnId: columnaQueSeLeeDespues,
      title: "baja",
      position: 0,
      id: idBajo,
    });
    await insertTask(db, {
      boardId,
      columnId: columnaQueSeLeeDespues,
      title: "media",
      position: 1,
      id: idMedio,
    });
    const porId = [idAlto, idBajo, idMedio].sort();

    // PRECONDICION, y no un comentario: si alguien toca el fixture y los dos
    // ordenes vuelven a coincidir, esta prueba deja de decir nada sobre el
    // orden de `task_ids` y tiene que caer ACA, con el motivo escrito, en vez
    // de seguir verde por una razon equivocada. Se lee de la base con el MISMO
    // ORDER BY que usa `lockBoardTaskIds`, no de nuestra idea de como ordena
    // PostgreSQL los uuid.
    const comoSeLeen = await db.query<{ id: string }>(
      `SELECT id FROM task WHERE board_id = $1 ORDER BY column_id, id`,
      [boardId],
    );
    expect(
      comoSeLeen.rows.map((fila) => fila.id),
      "el fixture dejo de invertir el orden: leer por (column_id, id) y ordenar por id " +
        "dan lo mismo con estos ids, asi que la prueba ya no puede ver si el servicio ordena",
    ).not.toEqual(porId);

    await tableros.delete(boardId, ctx());

    const fila = await unico();
    expect([fila.action, fila.entity_type, fila.entity_id]).toEqual([
      "DELETE",
      "board",
      boardId,
    ]);
    expect(fila.after_data).toBeNull();
    expect(fila.before_data?.["name"]).toBe("Personal");
    expect((fila.before_data?.["columns"] as unknown[]).length).toBe(2);
    // Igualdad EXACTA de la lista, y no un toContain ni un length: se prepara
    // un soft delete sobre estos ids, asi que un id de mas —uno que sobrevivio
    // al borrado— es tan grave como uno de menos. `toEqual` sobre arrays es
    // sensible a longitud y a orden, que son las dos formas de equivocarse.
    expect(fila.before_data?.["cascade"]).toEqual({ tasks: 3, task_ids: porId });
    expect(await contarFilas(db, "task")).toBe(0);
  });

  it("un tablero SIN tareas dice tasks 0 y una lista vacia, no una lista ausente", async () => {
    // El caso que rompe un `if (ids.length > 0)` mal puesto: quien lea el
    // registro tiene que poder hacer `cascade.task_ids.length` sin preguntar
    // primero si la clave esta.
    const t = await sembrar();

    await tableros.delete(t.boardId, ctx());

    const fila = await unico();
    expect(fila.before_data?.["cascade"]).toEqual({ tasks: 0, task_ids: [] });
  });
});

describe("las lecturas no se auditan (7.4)", () => {
  it("ninguna de las siete", async () => {
    const t = await sembrar();
    const taskId = await insertTask(db, {
      boardId: t.boardId,
      columnId: t.todo,
      title: "Buscable",
      position: 0,
    });

    await tableros.get(t.boardId);
    await tableros.list();
    await tareas.get(taskId);
    await tareas.list({ boardId: t.boardId });
    await tareas.list({ boardId: t.boardId, columnKey: "TODO" });
    await tareas.search("Buscable", { boardId: t.boardId });
    await tareas.search("nada");

    expect(await auditoria()).toEqual([]);
  });
});

describe("una operacion fallida no deja registro", () => {
  it("ni cuando falla antes de escribir", async () => {
    const t = await sembrar();

    await capturar(() =>
      tareas.create({ boardId: uuid(), columnId: t.todo, title: "Huerfana" }, ctx()),
    );
    await capturar(() => tareas.update(uuid(), { title: "X" }, ctx()));
    await capturar(() => tareas.delete(uuid(), ctx()));
    await capturar(() => tareas.move(uuid(), { columnId: t.done, position: 0 }, ctx()));
    await capturar(() => tableros.delete(uuid(), ctx()));
    await capturar(() => columnas.create({ boardId: t.boardId, name: "X", key: "TODO" }, ctx()));

    expect(await auditoria()).toEqual([]);
  });

  it("ni cuando falla con la transaccion ya abierta", async () => {
    const t = await sembrar();
    await insertTask(db, { boardId: t.boardId, columnId: t.todo, title: "Ocupa", position: 0 });

    // Este falla adentro y no en la validacion previa: la transaccion ya esta
    // abierta y ya leyo la columna, el tablero y el recuento de tareas.
    const otro = await sembrar();
    const error = await capturar(() =>
      columnas.delete(t.todo, { reassignTo: otro.done }, ctx()),
    );

    expect((error as DomainError).code).toBe("COLUMN_NOT_IN_BOARD");
    expect(await auditoria()).toEqual([]);
  });
});

describe("un fallo al escribir el registro revierte la operacion", () => {
  it("cuando lo rechaza la base", async () => {
    const t = await sembrar();

    // 121 caracteres contra un VARCHAR(120): el INSERT de auditoria falla con
    // 22001. El nucleo NO valida esto a proposito (lo recorta el borde, ver
    // `contextoDeAgente`), asi que es un fallo real de la base y no un mock.
    const desbordado: ActorContext = {
      actorType: "API",
      actorName: "a".repeat(121),
      requestId: uuid(),
    };

    await capturar(() =>
      tareas.create({ boardId: t.boardId, columnId: t.todo, title: "No queda" }, desbordado),
    );

    expect(await contarFilas(db, "task")).toBe(0);
    expect(await contarFilas(db, "audit_log")).toBe(0);
  });

  it("cuando falla el propio AuditService", async () => {
    class AuditoriaRota extends AuditService {
      override async registrar(
        _tx: AuditTransaction,
        _ctx: ActorContext,
        _evento: AuditEvent,
      ): Promise<void> {
        throw new Error("auditoria caida");
      }
    }

    const boards = new BoardRepository(new TransactionRunner(prisma));
    const rotos = {
      tableros: new BoardService(boards, new AuditoriaRota()),
      columnas: new ColumnService(boards, new AuditoriaRota()),
      tareas: new TaskService(new TaskRepository(new TransactionRunner(prisma)), new AuditoriaRota()),
    };

    const t = await sembrar();
    const taskId = await insertTask(db, {
      boardId: t.boardId,
      columnId: t.todo,
      title: "Intacta",
      position: 0,
    });

    await capturar(() => rotos.tableros.create({ name: "No queda" }, ctx()));
    await capturar(() => rotos.columnas.create({ boardId: t.boardId, name: "X", key: "X" }, ctx()));
    await capturar(() =>
      rotos.tareas.create({ boardId: t.boardId, columnId: t.todo, title: "No queda" }, ctx()),
    );
    await capturar(() => rotos.tareas.update(taskId, { title: "Cambiada" }, ctx()));
    await capturar(() => rotos.tareas.move(taskId, { columnId: t.done, position: 0 }, ctx()));
    await capturar(() => rotos.tareas.delete(taskId, ctx()));
    await capturar(() => rotos.tableros.delete(t.boardId, ctx()));

    // Nada de todo eso ocurrio: ni lo que se creaba, ni lo que se modificaba,
    // ni lo que se borraba.
    expect(await contarFilas(db, "board")).toBe(1);
    expect(await contarFilas(db, "board_column")).toBe(2);
    expect(await contarFilas(db, "task")).toBe(1);
    expect(await contarFilas(db, "audit_log")).toBe(0);

    const filas = await db.query<{ title: string; column_id: string }>(
      `SELECT title, column_id FROM task WHERE id = $1`,
      [taskId],
    );
    expect(filas.rows[0]).toEqual({ title: "Intacta", column_id: t.todo });
  });
});

describe("un reintento produce un solo registro", () => {
  /**
   * Aborta el primer intento DESPUES de correr la operacion entera, con la
   * misma forma de error que produce una contencion real: el DriverAdapterError
   * pelado que describe `db-error.ts`, con la causa colgando de `cause`.
   *
   * Se fuerza en vez de provocarlo con dos operaciones simultaneas porque el
   * punto de la prueba es contar registros, no medir contencion: con carga real
   * el reintento ocurre casi siempre, y "casi siempre" en un test que existe
   * para detectar duplicados significa que a veces no prueba nada.
   */
  function abortaElPrimerIntento(real: PrismaClient): {
    cliente: PrismaClient;
    intentos: () => number;
  } {
    let intentos = 0;

    const cliente = new Proxy(real, {
      get(objetivo, propiedad, receptor: unknown) {
        if (propiedad !== "$transaction") {
          return Reflect.get(objetivo, propiedad, receptor);
        }

        return async (cuerpo: (tx: unknown) => Promise<unknown>, opciones: unknown) =>
          (objetivo.$transaction as unknown as (
            fn: (tx: unknown) => Promise<unknown>,
            opciones: unknown,
          ) => Promise<unknown>)(async (tx: unknown) => {
            const salida = await cuerpo(tx);
            intentos += 1;
            if (intentos === 1) {
              throw new Error("conflicto simulado en el COMMIT", {
                cause: { kind: "SerializationFailure", originalCode: SERIALIZATION_FAILURE },
              });
            }
            return salida;
          }, opciones);
      },
    }) as PrismaClient;

    return { cliente, intentos: () => intentos };
  }

  it("aunque la operacion corra dos veces, el registro queda una sola", async () => {
    const t = await sembrar();
    const { cliente, intentos } = abortaElPrimerIntento(prisma);
    const conReintento = new TaskService(new TaskRepository(new TransactionRunner(cliente)));

    const tarea = await conReintento.create(
      { boardId: t.boardId, columnId: t.todo, title: "Una sola vez" },
      ctx(),
    );

    // Dos intentos, una tarea, un registro: el del intento abortado se fue con
    // su transaccion. Es el error mas facil de cometer aca —acumular eventos
    // fuera de la transaccion y escribirlos al final— y no se nota hasta que se
    // audita en serio.
    expect(intentos()).toBe(2);
    expect(await contarFilas(db, "task")).toBe(1);

    const fila = await unico();
    expect([fila.action, fila.entity_id]).toEqual(["CREATE", tarea.id]);
  });
});

describe("los ids de la cascada son los que se borraron, no los que se leyeron", () => {
  /**
   * Fuerza el entrelazado que hace inexacta una lectura sin bloqueo: OTRA
   * sesion borra una tarea del tablero DESPUES de que el borrado abrio su
   * snapshot y ANTES de que lea las tareas.
   *
   * La perturbacion se cuela justo antes del unico `$queryRaw` del borrado, que
   * es la lectura bloqueante: para entonces `findBoard` ya corrio —o sea que el
   * snapshot de REPEATABLE READ ya esta fijado— y todavia no hay ninguna fila
   * de `task` bloqueada, asi que el DELETE de la otra sesion no espera a nadie.
   *
   * Y ocurre UNA sola vez, en el primer intento: si se repitiera en cada
   * reintento no se mediria la exactitud sino el presupuesto de reintentos, que
   * es el mismo motivo por el que el aborto de arriba tambien se limita al
   * primero.
   *
   * Determinista a proposito, como el de arriba y por lo mismo: con dos
   * operaciones simultaneas de verdad el entrelazado que importa ocurre casi
   * siempre, y "casi siempre" en una prueba de exactitud significa que a veces
   * no prueba nada.
   */
  function borraUnaTareaAntesDeLaLectura(
    real: PrismaClient,
    borrar: () => Promise<void>,
  ): { cliente: PrismaClient; intentos: () => number } {
    let intentos = 0;
    let perturbado = false;

    function conPerturbacion(tx: object): object {
      return new Proxy(tx, {
        get(objetivo, propiedad, receptor: unknown) {
          const valor = Reflect.get(objetivo, propiedad, receptor);
          if (propiedad !== "$queryRaw" || perturbado) {
            return valor;
          }

          return async (...argumentos: unknown[]) => {
            perturbado = true;
            await borrar();
            return (valor as (...a: unknown[]) => unknown).apply(objetivo, argumentos);
          };
        },
      });
    }

    const cliente = new Proxy(real, {
      get(objetivo, propiedad, receptor: unknown) {
        if (propiedad !== "$transaction") {
          return Reflect.get(objetivo, propiedad, receptor);
        }

        return async (cuerpo: (tx: unknown) => Promise<unknown>, opciones: unknown) =>
          (objetivo.$transaction as unknown as (
            fn: (tx: unknown) => Promise<unknown>,
            opciones: unknown,
          ) => Promise<unknown>)(async (tx: unknown) => {
            intentos += 1;
            return cuerpo(conPerturbacion(tx as object));
          }, opciones);
      },
    }) as PrismaClient;

    return { cliente, intentos: () => intentos };
  }

  it("una tarea borrada por otra sesion no queda en task_ids", async () => {
    const t = await sembrar();
    const ids = await insertTasks(db, {
      boardId: t.boardId,
      columnId: t.todo,
      prefijo: "t",
      cantidad: 3,
    });
    const [, , tercera] = ids as [string, string, string];
    const supervivientes = ids.filter((id) => id !== tercera).sort();

    const { cliente, intentos } = borraUnaTareaAntesDeLaLectura(prisma, async () => {
      await db.query("DELETE FROM task WHERE id = $1", [tercera]);
    });
    const conCarrera = new BoardService(new BoardRepository(new TransactionRunner(cliente)));

    await conCarrera.delete(t.boardId, ctx());

    // Dos intentos: el primero no pudo bloquear una fila que ya no estaba y
    // salio por 40001. Sin el FOR UPDATE de `lockBoardTaskIds` este borrado
    // terminaria en UN intento y registraria los tres ids, uno de ellos de una
    // tarea que este borrado no se llevo.
    expect(intentos()).toBe(2);

    const fila = await unico();
    expect(fila.before_data?.["cascade"]).toEqual({
      tasks: 2,
      task_ids: supervivientes,
    });
    expect(await contarFilas(db, "task")).toBe(0);
  });
});

describe("el actor sale del contexto", () => {
  it("los tres origenes se registran tal cual (7.4)", async () => {
    for (const actorType of ["USER", "AGENT", "API"] as const) {
      await tableros.create(
        { name: `Tablero ${actorType}` },
        { actorType, actorName: `origen-${actorType}`, requestId: uuid() },
      );
    }

    expect((await auditoria()).map((fila) => [fila.actor_type, fila.actor_name])).toEqual([
      ["USER", "origen-USER"],
      ["AGENT", "origen-AGENT"],
      ["API", "origen-API"],
    ]);
  });

  it("clientId y requestId viajan al registro; clientId ausente queda NULL", async () => {
    const requestId = uuid();

    await tableros.create(
      { name: "Con cliente" },
      { actorType: "API", actorName: "rest", clientId: "tk_abc123", requestId },
    );
    await tableros.create({ name: "Sin cliente" }, { actorType: "API", actorName: "rest", requestId: uuid() });

    const filas = await auditoria();
    expect(filas[0]?.client_id).toBe("tk_abc123");
    expect(filas[0]?.request_id).toBe(requestId);
    expect(filas[1]?.client_id).toBeNull();
  });
});

describe("una operacion, un registro", () => {
  it("el ciclo completo de una tarea deja cuatro eventos y ninguno de mas", async () => {
    const tablero: BoardDetail = await tableros.create({ name: "Ciclo" }, ctx());
    const todo = porKey(tablero.columns, "TODO");
    const done = porKey(tablero.columns, "DONE");

    const tarea = await tareas.create({ boardId: tablero.id, columnId: todo, title: "Ciclo" }, ctx());
    await tareas.update(tarea.id, { priority: "HIGH" }, ctx());
    await tareas.move(tarea.id, { columnId: done, position: 0 }, ctx());
    await tareas.delete(tarea.id, ctx());

    expect(await acciones()).toEqual([
      "CREATE board",
      "CREATE task",
      "UPDATE task",
      "MOVE task",
      "DELETE task",
    ]);
  });
});

/** Vacia solo la auditoria, para leer los registros de UNA operacion puntual. */
async function truncateAudit(): Promise<void> {
  await db.query(`TRUNCATE TABLE audit_log RESTART IDENTITY`);
}
