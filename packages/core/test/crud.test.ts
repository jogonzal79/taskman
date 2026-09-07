import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError, TaskRepository, TaskService } from "../src/index.js";
import {
  connectDb,
  expectColumnaDensa,
  insertBoard,
  insertColumn,
  insertTasks,
  leerOrden,
  truncateAll,
  uuid,
} from "./helpers.js";

let db: Client;
let servicio: TaskService;

beforeAll(async () => {
  db = await connectDb();
  servicio = new TaskService(new TaskRepository(prisma));
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

interface Tablero {
  boardId: string;
  todo: string;
  done: string;
  tareasTodo: string[];
}

async function sembrar(cantidad = 3): Promise<Tablero> {
  const boardId = await insertBoard(db);
  const todo = await insertColumn(db, { boardId, key: "TODO", position: 0 });
  const done = await insertColumn(db, { boardId, key: "DONE", position: 1 });

  return {
    boardId,
    todo,
    done,
    tareasTodo: await insertTasks(db, { boardId, columnId: todo, prefijo: "todo", cantidad }),
  };
}

async function capturarDominio(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return error;
    }
    throw error;
  }
  throw new Error("Se esperaba un DomainError, pero la operacion termino sin error.");
}

async function leerTitulo(taskId: string): Promise<string> {
  const filas = await db.query<{ title: string }>(`SELECT title FROM task WHERE id = $1`, [taskId]);
  return filas.rows[0]?.title ?? "";
}

describe("create", () => {
  it("sin position va al final de la columna", async () => {
    const t = await sembrar();

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Nueva",
    });

    expect(creada.position).toBe(3);
    expect(creada.priority).toBe("MEDIUM");
    expect(creada.description).toBeNull();
    expect(await leerOrden(db, t.todo)).toEqual([...t.tareasTodo, creada.id]);
    await expectColumnaDensa(db, t.todo);
  });

  it("con position intermedia desplaza las siguientes", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Intercalada",
      position: 1,
    });

    expect(creada.position).toBe(1);
    expect(await leerOrden(db, t.todo)).toEqual([primera, creada.id, segunda, tercera]);
    await expectColumnaDensa(db, t.todo);
  });

  it("con position mayor que la columna se ajusta al final", async () => {
    const t = await sembrar();

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Desbordada",
      position: 999,
    });

    expect(creada.position).toBe(3);
    await expectColumnaDensa(db, t.todo);
  });

  it("guarda los campos opcionales", async () => {
    const t = await sembrar(0);

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Con todo",
      description: "Una descripcion",
      priority: "URGENT",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    expect(creada.description).toBe("Una descripcion");
    expect(creada.priority).toBe("URGENT");
    expect(creada.dueDate?.toISOString().slice(0, 10)).toBe("2026-09-11");
  });

  it("BOARD_NOT_FOUND si el tablero no existe", async () => {
    const t = await sembrar();
    const inexistente = uuid();

    const error = await capturarDominio(() =>
      servicio.create({ boardId: inexistente, columnId: t.todo, title: "X" }),
    );

    expect(error.code).toBe("BOARD_NOT_FOUND");
    expect(await leerOrden(db, t.todo)).toEqual(t.tareasTodo);
  });

  it("COLUMN_NOT_FOUND si la columna no existe", async () => {
    const t = await sembrar();

    const error = await capturarDominio(() =>
      servicio.create({ boardId: t.boardId, columnId: uuid(), title: "X" }),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("COLUMN_NOT_IN_BOARD si la columna es de otro tablero", async () => {
    const t = await sembrar();
    const otro = await insertBoard(db, "Otro");
    const ajena = await insertColumn(db, { boardId: otro, key: "TODO", position: 0 });

    const error = await capturarDominio(() =>
      servicio.create({ boardId: t.boardId, columnId: ajena, title: "X" }),
    );

    expect(error.code).toBe("COLUMN_NOT_IN_BOARD");
  });

  it("INVALID_ORDER si la position es negativa", async () => {
    const t = await sembrar();

    const error = await capturarDominio(() =>
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "X", position: -1 }),
    );

    expect(error.code).toBe("INVALID_ORDER");
    expect(await leerOrden(db, t.todo)).toEqual(t.tareasTodo);
  });
});

describe("normalizacion del titulo", () => {
  it("guarda el titulo recortado", async () => {
    const t = await sembrar(0);

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "  a  ",
    });

    expect(creada.title).toBe("a");
    // Y lo recortado es lo que llego a la base, no solo lo que devolvimos.
    expect(await leerTitulo(creada.id)).toBe("a");
  });

  it("rechaza un titulo de un solo espacio duro U+00A0", async () => {
    const t = await sembrar(0);

    const error = await capturarDominio(() =>
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: " " }),
    );

    // La restriccion de base lo aceptaria: su clase de blancos es solo ASCII.
    expect(error.code).toBe("TITLE_REQUIRED");
  });

  it("rechaza otros blancos Unicode que se le escapan a la base", async () => {
    const t = await sembrar(0);

    for (const blanco of [" ", "", "　", "  \t\n"]) {
      const error = await capturarDominio(() =>
        servicio.create({ boardId: t.boardId, columnId: t.todo, title: blanco }),
      );
      expect(error.code).toBe("TITLE_REQUIRED");
    }
  });

  it("acepta un titulo de exactamente 200 caracteres", async () => {
    const t = await sembrar(0);
    const limite = "a".repeat(200);

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: limite,
    });

    expect(creada.title).toHaveLength(200);
    expect(await leerTitulo(creada.id)).toBe(limite);
  });

  it("rechaza 201 caracteres con un error de dominio, no de Prisma", async () => {
    const t = await sembrar(0);

    const error = await capturarDominio(() =>
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "a".repeat(201) }),
    );

    // capturarDominio re-lanza cualquier cosa que no sea DomainError, asi que
    // llegar aca ya descarta el 22001 crudo de PostgreSQL.
    expect(error.code).toBe("TITLE_TOO_LONG");
    expect(error.details).toMatchObject({ length: 201, maxLength: 200 });
    expect(error.hint).toBeDefined();
  });

  it("el limite se mide despues del recorte", async () => {
    const t = await sembrar(0);
    // 206 caracteres en crudo, 200 tras recortar.
    const conBlancos = `   ${"a".repeat(200)}   `;

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: conBlancos,
    });

    expect(creada.title).toHaveLength(200);
  });

  it("cuenta caracteres, no unidades UTF-16", async () => {
    const t = await sembrar(0);
    // 150 emojis: 150 caracteres para el VARCHAR, 300 para String.length.
    const emojis = "\u{1F600}".repeat(150);

    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: emojis,
    });

    expect([...creada.title]).toHaveLength(150);
  });
});

describe("get", () => {
  it("devuelve la tarea", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const tarea = await servicio.get(primera);

    expect(tarea.id).toBe(primera);
    expect(tarea.columnId).toBe(t.todo);
  });

  it("TASK_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => servicio.get(uuid()));
    expect(error.code).toBe("TASK_NOT_FOUND");
  });
});

describe("update", () => {
  it("aplica solo los campos presentes", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];
    const antes = await servicio.get(primera);

    const despues = await servicio.update(primera, { priority: "HIGH" });

    expect(despues.priority).toBe("HIGH");
    expect(despues.title).toBe(antes.title);
    expect(despues.description).toBe(antes.description);
    // position y columnId no son modificables aca.
    expect(despues.position).toBe(antes.position);
    expect(despues.columnId).toBe(antes.columnId);
  });

  it("un null explicito borra el campo", async () => {
    const t = await sembrar(0);
    const creada = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Con descripcion",
      description: "Algo",
    });

    const despues = await servicio.update(creada.id, { description: null });

    expect(despues.description).toBeNull();
  });

  it("un patch sin cambio efectivo es exitoso y no escribe", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];
    const antes = await servicio.get(primera);

    const despues = await servicio.update(primera, {
      title: antes.title,
      priority: antes.priority,
    });

    expect(despues).toEqual(antes);
    // No escribio: la marca de tiempo quedo intacta.
    expect(despues.updatedAt.getTime()).toBe(antes.updatedAt.getTime());
  });

  it("un patch vacio tambien es exitoso", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const despues = await servicio.update(primera, {});

    expect(despues.id).toBe(primera);
  });

  it("recorta el titulo igual que create", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const despues = await servicio.update(primera, { title: "  recortado  " });

    expect(despues.title).toBe("recortado");
    expect(await leerTitulo(primera)).toBe("recortado");
  });

  it("rechaza un titulo que pasa de 200 tras el recorte", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const error = await capturarDominio(() =>
      servicio.update(primera, { title: "a".repeat(201) }),
    );

    expect(error.code).toBe("TITLE_TOO_LONG");
  });

  it("TASK_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => servicio.update(uuid(), { priority: "LOW" }));
    expect(error.code).toBe("TASK_NOT_FOUND");
  });
});

describe("delete", () => {
  it("de una tarea intermedia deja la columna densa", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];

    await servicio.delete(segunda);

    expect(await leerOrden(db, t.todo)).toEqual([primera, tercera]);
    await expectColumnaDensa(db, t.todo);
  });

  it("de la ultima tarea deja la columna vacia", async () => {
    const t = await sembrar(1);
    const [unica] = t.tareasTodo as [string];

    await servicio.delete(unica);

    expect(await leerOrden(db, t.todo)).toEqual([]);
    await expectColumnaDensa(db, t.todo);
  });

  it("TASK_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => servicio.delete(uuid()));
    expect(error.code).toBe("TASK_NOT_FOUND");
  });
});

describe("list", () => {
  it("filtra por columna y ordena por position", async () => {
    const t = await sembrar();
    await insertTasks(db, { boardId: t.boardId, columnId: t.done, prefijo: "done", cantidad: 2 });

    const pagina = await servicio.list({ columnId: t.todo });

    expect(pagina.items.map((tarea) => tarea.id)).toEqual(t.tareasTodo);
    expect(pagina.nextCursor).toBeNull();
  });

  it("filtra por prioridad como OR", async () => {
    const t = await sembrar(0);
    const alta = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Alta",
      priority: "HIGH",
    });
    const urgente = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Urgente",
      priority: "URGENT",
    });
    await servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Normal" });

    const pagina = await servicio.list({
      boardId: t.boardId,
      priority: ["HIGH", "URGENT"],
    });

    expect(new Set(pagina.items.map((tarea) => tarea.id))).toEqual(new Set([alta.id, urgente.id]));
  });

  it("pagina por cursor sin repetir ni perder filas", async () => {
    const t = await sembrar(5);

    const vistas: string[] = [];
    let cursor: string | null = null;
    for (let vuelta = 0; vuelta < 10; vuelta += 1) {
      const pagina: { items: Array<{ id: string }>; nextCursor: string | null } =
        await servicio.list({
          columnId: t.todo,
          limit: 2,
          ...(cursor === null ? {} : { cursor }),
        });
      vistas.push(...pagina.items.map((tarea) => tarea.id));
      cursor = pagina.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(vistas).toEqual(t.tareasTodo);
  });

  it("respeta el limite maximo de pagina", async () => {
    const t = await sembrar(3);

    const pagina = await servicio.list({ columnId: t.todo, limit: 100_000 });

    expect(pagina.items).toHaveLength(3);
  });

  it("overdue deja fuera lo vencido que ya esta en DONE", async () => {
    const t = await sembrar(0);
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const pendiente = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Vencida pendiente",
      dueDate: ayer,
    });
    await servicio.create({
      boardId: t.boardId,
      columnId: t.done,
      title: "Vencida terminada",
      dueDate: ayer,
    });
    await servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Sin fecha" });

    const pagina = await servicio.list({ boardId: t.boardId, overdue: true });

    expect(pagina.items.map((tarea) => tarea.id)).toEqual([pendiente.id]);
  });
});

describe("search", () => {
  it("encuentra por titulo y por descripcion", async () => {
    const t = await sembrar(0);
    const porTitulo = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Revisar el contrato",
    });
    const porDescripcion = await servicio.create({
      boardId: t.boardId,
      columnId: t.todo,
      title: "Pendiente",
      description: "Falta firmar el contrato",
    });
    await servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Nada que ver" });

    const pagina = await servicio.search("contrato", { boardId: t.boardId });

    expect(new Set(pagina.items.map((coincidencia) => coincidencia.task.id))).toEqual(
      new Set([porTitulo.id, porDescripcion.id]),
    );
    for (const coincidencia of pagina.items) {
      expect(coincidencia.rank).toBeGreaterThan(0);
    }
  });

  it("acota por tablero", async () => {
    const t = await sembrar(0);
    const otro = await insertBoard(db, "Otro");
    const ajena = await insertColumn(db, { boardId: otro, key: "TODO", position: 0 });

    await servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Informe mensual" });
    await servicio.create({ boardId: otro, columnId: ajena, title: "Informe mensual" });

    const pagina = await servicio.search("informe", { boardId: t.boardId });

    expect(pagina.items).toHaveLength(1);
    expect(pagina.items[0]?.task.boardId).toBe(t.boardId);
  });

  it("sin coincidencias devuelve una pagina vacia", async () => {
    const t = await sembrar(2);

    const pagina = await servicio.search("inexistente", { boardId: t.boardId });

    expect(pagina.items).toEqual([]);
    expect(pagina.nextCursor).toBeNull();
  });
});

describe("concurrencia", () => {
  it("dos create simultaneos en la misma columna terminan los dos", async () => {
    const t = await sembrar();

    const resultados = await Promise.allSettled([
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "A", position: 0 }),
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "B", position: 0 }),
    ]);

    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const orden = await leerOrden(db, t.todo);
    expect(orden).toHaveLength(5);
    expect(new Set(orden).size).toBe(5);
    await expectColumnaDensa(db, t.todo);
  });

  it("delete y create simultaneos en la misma columna dejan el orden denso", async () => {
    const t = await sembrar();
    const [, segunda] = t.tareasTodo as [string, string, string];

    const resultados = await Promise.allSettled([
      servicio.delete(segunda),
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Nueva", position: 1 }),
    ]);

    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const orden = await leerOrden(db, t.todo);
    expect(orden).toHaveLength(3);
    expect(new Set(orden).size).toBe(3);
    expect(orden).not.toContain(segunda);
    await expectColumnaDensa(db, t.todo);
  });

  it("dos create simultaneos sobre una columna VACIA terminan los dos", async () => {
    // El caso que no cubre el bloqueo de filas: sobre una columna vacia no hay
    // ninguna fila que bloquear, asi que las dos transacciones calculan
    // position 0 sin verse y la UNIQUE diferida las separa en el COMMIT. Lo que
    // las salva es el reintento ante task_column_position_uniq.
    const t = await sembrar(0);
    expect(await leerOrden(db, t.todo)).toEqual([]);

    const resultados = await Promise.allSettled([
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "A" }),
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "B" }),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    const orden = await leerOrden(db, t.todo);
    expect(orden).toHaveLength(2);
    expect(new Set(orden).size).toBe(2);
    await expectColumnaDensa(db, t.todo);
  });

  it("una rafaga de create y delete deja la columna densa", async () => {
    const t = await sembrar(4);
    const [primera, , tercera] = t.tareasTodo as [string, string, string, string];

    const resultados = await Promise.allSettled([
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "X", position: 0 }),
      servicio.delete(primera),
      servicio.create({ boardId: t.boardId, columnId: t.todo, title: "Y", position: "end" }),
      servicio.delete(tercera),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    const orden = await leerOrden(db, t.todo);
    expect(orden).toHaveLength(4);
    expect(new Set(orden).size).toBe(4);
    await expectColumnaDensa(db, t.todo);
  });
});
