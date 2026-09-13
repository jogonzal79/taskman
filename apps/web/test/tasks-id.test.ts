import type { Tarea } from "@taskman/contracts";
import type { BoardDetail, CorePort, Task } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DELETE as eliminar, PATCH as actualizar } from "../app/api/tasks/[id]/route";
import {
  connectDb,
  contarFilas,
  contextoDeRuta,
  ctx,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de PATCH y DELETE /api/tasks/{id} (6.2, RF-05 y RF-06).
 *
 * El GET de esta misma ruta esta en `tasks.test.ts`, junto al POST que crea lo
 * que el GET lee. Mismo enfoque que el resto de la suite: los handlers se
 * importan y se invocan con un `Request` armado a mano y con el contexto de
 * ruta que les pasaria Next. Ver el comentario de cabecera de `boards.test.ts`
 * para el razonamiento completo, incluido el de por que cada caso usa una clave
 * con exactamente el scope que necesita.
 *
 * Todo lo que es ESTADO se comprueba por SQL y nunca por la respuesta: lo que
 * hay que verificar es lo que quedo en la base, y leerlo del cuerpo que el
 * adaptador acaba de construir probaria que se copia a si mismo. Vale sobre
 * todo para los dos casos centrales de este archivo: el campo que un PATCH NO
 * tiene que tocar, y el orden que queda tras un DELETE.
 */

/** Las claves de `tarea` (contracts), los campos de la 6.3.1. */
const CLAVES_TAREA = [
  "board_id",
  "column_id",
  "created_at",
  "description",
  "due_date",
  "id",
  "position",
  "priority",
  "title",
  "updated_at",
];

const UUID_INEXISTENTE = "11111111-2222-4333-8444-555555555555";

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveWrite: string;
let claveDelete: string;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveRead = await emitirClave(client, ["READ"]);
  claveWrite = await emitirClave(client, ["WRITE"]);
  claveDelete = await emitirClave(client, ["DELETE"]);
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

/**
 * Una tarea al final de la columna, con los campos que el PATCH puede cambiar.
 *
 * Va por el `CorePort` y no por el borde, igual que el resto de la siembra de la
 * suite: lo que se prueba aca es el PATCH y el DELETE, y sembrar con el POST
 * ataria estos casos a que el create siga aceptando la misma forma de cuerpo.
 */
async function sembrarTarea(args: {
  boardId: string;
  columnKey: string;
  title: string;
  description?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate?: Date | null;
}): Promise<Task> {
  return taskman.createTask(
    {
      boardId: args.boardId,
      columnKey: args.columnKey,
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.dueDate === undefined ? {} : { dueDate: args.dueDate }),
    },
    ctx(),
  );
}

interface FilaDeTarea {
  title: string;
  description: string | null;
  priority: string;
  due_date: string | null;
  position: number;
  column_id: string;
  updated_at: string;
}

/**
 * La fila de `task` leida de la base. `due_date::text` es lo que PostgreSQL
 * tiene guardado de verdad, sin que lo toque ningun driver ni ninguna zona
 * horaria: es la unica forma de comprobar la fecha sin que la comprobacion
 * herede el mismo error que querria detectar.
 */
async function leerTarea(taskId: string): Promise<FilaDeTarea | undefined> {
  const filas = await client.query<FilaDeTarea>(
    `SELECT title, description, priority, due_date::text AS due_date, position,
            column_id::text AS column_id, updated_at::text AS updated_at
       FROM task WHERE id = $1::uuid`,
    [taskId],
  );
  return filas.rows[0];
}

/** Los titulos de las tareas de una columna, en orden de position. */
async function titulosPorPosicion(columnId: string): Promise<string[]> {
  const filas = await client.query<{ title: string }>(
    `SELECT title FROM task WHERE column_id = $1::uuid ORDER BY position`,
    [columnId],
  );
  return filas.rows.map((fila) => fila.title);
}

/** El orden de tareas de la columna es exactamente 0..n-1 (ADR-004). */
async function expectColumnaDensa(columnId: string): Promise<void> {
  const filas = await client.query<{ position: number }>(
    `SELECT position FROM task WHERE column_id = $1::uuid ORDER BY position`,
    [columnId],
  );
  const posiciones = filas.rows.map((fila) => fila.position);
  expect(posiciones).toEqual(posiciones.map((_, indice) => indice));
}

interface FilaDeAuditoria {
  action: string;
  entity_type: string;
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  actor_type: string;
  actor_name: string;
  client_id: string | null;
  request_id: string | null;
}

/** El ultimo registro de auditoria, sea de la operacion que sea. */
async function ultimoRegistro(): Promise<FilaDeAuditoria | undefined> {
  const filas = await client.query<FilaDeAuditoria>(
    `SELECT action, entity_type, entity_id, before_data, after_data,
            actor_type::text AS actor_type, actor_name, client_id, request_id
       FROM audit_log ORDER BY id DESC LIMIT 1`,
  );
  return filas.rows[0];
}

describe("PATCH /api/tasks/{id}", () => {
  it("200 cambiando solo el title: ningun otro campo se toca", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "antes" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Revisar HU-25",
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { title: "Revisar HU-26" },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<Tarea>(respuesta);

    // La tarea SOLA, con las claves de la 6.3.1: sin columnas, sin orden y sin
    // ninguna envoltura, siguiendo el precedente de POST /api/tasks.
    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_TAREA);
    expect(cuerpo.title).toBe("Revisar HU-26");

    // Y en la base, que es donde importa: un patch parcial de title deja los
    // otros cinco campos como estaban, incluida la position.
    expect(await leerTarea(tarea.id)).toMatchObject({
      title: "Revisar HU-26",
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      due_date: "2026-09-11",
      position: 1,
      column_id: todo,
    });
  });

  it("200 sin description en el cuerpo: la descripcion se conserva", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Con descripcion",
      description: "la que ya tenia",
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { title: "Otro titulo" },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<Tarea>(respuesta)).description).toBe("la que ya tenia");
    expect((await leerTarea(tarea.id))?.description).toBe("la que ya tenia");
  });

  it("200 con description en null: la descripcion se borra", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Con descripcion",
      description: "la que ya tenia",
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { description: null },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<Tarea>(respuesta);

    expect(cuerpo.description).toBeNull();
    // El titulo no se toca: el patch es parcial en los dos sentidos.
    expect(cuerpo.title).toBe("Con descripcion");
    expect(await leerTarea(tarea.id)).toMatchObject({
      title: "Con descripcion",
      description: null,
    });
  });

  it("200 sin due_date en el cuerpo: el vencimiento se conserva", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Con vencimiento",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { priority: "URGENT" },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<Tarea>(respuesta)).due_date).toBe("2026-09-11");
    expect(await leerTarea(tarea.id)).toMatchObject({
      due_date: "2026-09-11",
      priority: "URGENT",
    });
  });

  it("200 con due_date en null: el vencimiento se quita", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Con vencimiento",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { due_date: null },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<Tarea>(respuesta)).due_date).toBeNull();
    expect((await leerTarea(tarea.id))?.due_date).toBeNull();
  });

  it("200 cambiando priority y due_date juntos, sin corrimiento de dia", async () => {
    // Los bordes donde un corrimiento de zona se nota: el 1 y el 31, mas el 29
    // de febrero. Con un offset negativo, un dia 1 mal anclado retrocede al mes
    // anterior. El patch cambia LOS DOS campos a la vez, que es lo que pide el
    // caso: `priority` no puede arrastrar a `due_date` ni al reves.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const fechas = ["2026-01-01", "2026-12-31", "2024-02-29", "2026-03-01"];

    for (const fecha of fechas) {
      const tarea = await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: `vence ${fecha}`,
        priority: "LOW",
      });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { priority: "URGENT", due_date: fecha },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(200);

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.priority).toBe("URGENT");
      expect(cuerpo.due_date).toBe(fecha);
      // Lo que PostgreSQL tiene guardado, como texto: sin driver ni zona en el
      // medio. Si hubiera corrimiento de dia, aca se ve.
      expect(await leerTarea(tarea.id)).toMatchObject({ priority: "URGENT", due_date: fecha });
    }
  });

  /**
   * La regla de la 5.2 que este endpoint tiene que defender por su cuenta:
   * `position` y `columnId` NO son modificables con update, requieren move.
   *
   * El nucleo no la defiende en tiempo de ejecucion. `UpdateTaskInput` no tiene
   * esos campos y `TaskService.update` lee uno por uno los cuatro que si tiene,
   * asi que un `position` que llegara hasta ahi no fallaria: quedaria IGNORADO,
   * y la respuesta seria un 200 con la tarea sin mover. Por eso el 400 sale del
   * borde, y por eso cada caso comprueba por SQL que la tarea no se movio: lo
   * que se esta probando no es el codigo de estado sino que no haya un camino
   * por el que el pedido se pierda en silencio.
   */
  describe("position y column_id no se cambian aca (5.2)", () => {
    it("400 con position en el cuerpo, y la tarea no se movio", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "primera" });
      const tarea = await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "segunda",
      });
      const auditoriaAntes = await contarFilas(client, "audit_log");

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { title: "segunda renombrada", position: 0 },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);

      const error = (await leerError(respuesta)).error;

      expect(error.code).toBe("VALIDATION_ERROR");
      // El hint es la parte accionable (5.3): nombra la llamada que SI hace lo
      // que se pidio, no solo el campo que sobra.
      expect(error.hint).toContain(`POST /api/tasks/${tarea.id}/move`);
      expect(error.hint).toContain("position");

      // Y nada se movio ni se escribio: el 400 es total, no parcial. El title
      // del mismo cuerpo tampoco se aplico.
      expect(await leerTarea(tarea.id)).toMatchObject({ title: "segunda", position: 1 });
      expect(await titulosPorPosicion(todo)).toEqual(["primera", "segunda"]);
      expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
    });

    it("400 con column_id en el cuerpo, y la tarea sigue en su columna", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const done = porKey(tablero, "DONE");
      const tarea = await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "sigue en TODO",
      });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { column_id: done },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);

      const error = (await leerError(respuesta)).error;

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.hint).toContain(`POST /api/tasks/${tarea.id}/move`);
      expect(error.hint).toContain("column_id");

      expect((await leerTarea(tarea.id))?.column_id).toBe(todo);
      expect(await titulosPorPosicion(done)).toEqual([]);
    });

    it("400 con column_key, que es el mismo pedido por otra referencia", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const tarea = await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "sigue en TODO",
      });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { column_key: "DONE" },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.hint).toContain("column_key");
      expect((await leerTarea(tarea.id))?.column_id).toBe(todo);
    });

    it("400 con los dos juntos: el hint los nombra a los dos", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "t" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { position: 0, column_id: porKey(tablero, "DONE") },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);

      const hint = (await leerError(respuesta)).error.hint ?? "";

      expect(hint).toContain("position");
      expect(hint).toContain("column_id");
    });
  });

  it("200 con un patch sin cambio efectivo: no escribe ni deja registro de auditoria", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Igual",
      description: "igual",
      priority: "HIGH",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });
    const antes = await leerTarea(tarea.id);
    const auditoriaAntes = await contarFilas(client, "audit_log");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: {
          title: "Igual",
          description: "igual",
          priority: "HIGH",
          due_date: "2026-09-11",
        },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<Tarea>(respuesta)).title).toBe("Igual");
    // 5.2: sin cambio efectivo la operacion es exitosa y NO genera registro de
    // auditoria. Que tampoco se escriba se ve en `updated_at`, que Prisma tocaria
    // en cualquier UPDATE aunque los valores fueran los mismos.
    expect(await leerTarea(tarea.id)).toEqual(antes);
    expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
  });

  it("200 con el cuerpo vacio: mismo caso que el patch sin cambios", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Igual" });
    const antes = await leerTarea(tarea.id);
    const auditoriaAntes = await contarFilas(client, "audit_log");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: {},
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect(await leerTarea(tarea.id)).toEqual(antes);
    expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
  });

  it("el patch con cambio efectivo SI deja un registro UPDATE con los campos modificados", async () => {
    // La contracara del caso anterior: si no se comprobara, "no audita nunca"
    // pasaria los dos tests.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Antes",
      priority: "LOW",
    });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveWrite,
        cuerpo: { title: "Despues" },
      }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);

    const registro = await ultimoRegistro();

    expect(registro).toMatchObject({
      action: "UPDATE",
      entity_type: "task",
      entity_id: tarea.id,
      actor_type: "API",
      request_id: respuesta.headers.get("X-Request-Id"),
    });
    // 5.2: before/after LIMITADO a los campos modificados. `priority` no se
    // mando y no aparece.
    expect(registro?.before_data).toEqual({ title: "Antes" });
    expect(registro?.after_data).toEqual({ title: "Despues" });
  });

  describe("entrada invalida", () => {
    it("404 con un id que no existe", async () => {
      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${UUID_INEXISTENTE}`,
          clave: claveWrite,
          cuerpo: { title: "Nuevo" },
        }),
        contextoDeRuta(UUID_INEXISTENTE),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("TASK_NOT_FOUND");
    });

    it("400 con un id que no es UUID, sin llegar a consultar", async () => {
      // Un id que no es UUID llega a PostgreSQL como texto y vuelve como un
      // 22P02 del driver, indistinguible de un fallo real: por eso se valida
      // antes.
      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: "/api/tasks/no-es-uuid",
          clave: claveWrite,
          cuerpo: { title: "Nuevo" },
        }),
        contextoDeRuta("no-es-uuid"),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un campo que no es editable y no tiene otro endpoint", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "t" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { board_id: tablero.id },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);

      const error = (await leerError(respuesta)).error;

      expect(error.code).toBe("VALIDATION_ERROR");
      // Sin hint: `board_id` no se cambia con ninguna llamada, asi que no hay
      // nada accionable que ofrecer. El hint es para los que SI tienen endpoint.
      expect(error.hint).toBeUndefined();
    });

    it("400 con title en null: una tarea sin titulo no existe", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Con titulo" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpo: { title: null },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect((await leerTarea(tarea.id))?.title).toBe("Con titulo");
    });

    it("400 con un cuerpo que no es JSON", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Intacta" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveWrite,
          cuerpoCrudo: "{no es json",
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect((await leerTarea(tarea.id))?.title).toBe("Intacta");
    });
  });

  describe("autorizacion", () => {
    it("401 sin clave, y no modifica nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Intacta" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          cuerpo: { title: "Modificada" },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
      expect((await leerTarea(tarea.id))?.title).toBe("Intacta");
    });

    it("403 con una clave sin scope write, y no modifica nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Intacta" });

      const respuesta = await actualizar(
        peticion({
          metodo: "PATCH",
          ruta: `/api/tasks/${tarea.id}`,
          clave: claveRead,
          cuerpo: { title: "Modificada" },
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "write",
        granted_scopes: ["read"],
      });
      expect((await leerTarea(tarea.id))?.title).toBe("Intacta");
    });
  });
});

describe("DELETE /api/tasks/{id}", () => {
  it("204 borrando una tarea intermedia: el orden restante queda denso (CT-05)", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const titulos = ["t-0", "t-1", "t-2", "t-3", "t-4"];
    const tareas: Task[] = [];

    for (const title of titulos) {
      tareas.push(await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title }));
    }

    expect(await titulosPorPosicion(todo)).toEqual(titulos);

    // La del medio, que es la que deja hueco si la reindexacion no ocurre.
    const intermedia = tareas[2];
    if (intermedia === undefined) {
      throw new Error("La siembra no dejo cinco tareas.");
    }

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${intermedia.id}`, clave: claveDelete }),
      contextoDeRuta(intermedia.id),
    );

    expect(respuesta.status).toBe(204);
    expect(await respuesta.text()).toBe("");
    // Es lo UNICO que devuelve un 204, y sin el no habria con que correlacionar
    // el borrado con su registro de auditoria (6.1).
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);

    expect(await leerTarea(intermedia.id)).toBeUndefined();
    // Denso 0..n-1 (ADR-004) y en el MISMO orden relativo: reindexar no puede
    // ser una excusa para reordenar lo que quedo.
    await expectColumnaDensa(todo);
    expect(await titulosPorPosicion(todo)).toEqual(["t-0", "t-1", "t-3", "t-4"]);
  });

  it("204 borrando la primera y la ultima: la columna sigue densa", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const tareas: Task[] = [];

    for (const title of ["t-0", "t-1", "t-2"]) {
      tareas.push(await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title }));
    }

    const [primera, , ultima] = tareas;
    if (primera === undefined || ultima === undefined) {
      throw new Error("La siembra no dejo tres tareas.");
    }

    for (const tarea of [primera, ultima]) {
      const respuesta = await eliminar(
        peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
        contextoDeRuta(tarea.id),
      );
      expect(respuesta.status).toBe(204);
      await expectColumnaDensa(todo);
    }

    expect(await titulosPorPosicion(todo)).toEqual(["t-1"]);
  });

  it("204 y no toca el orden de las OTRAS columnas del tablero", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const backlog = porKey(tablero, "BACKLOG");

    for (const title of ["b-0", "b-1"]) {
      await sembrarTarea({ boardId: tablero.id, columnKey: "BACKLOG", title });
    }
    const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "t-0" });

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(204);
    expect(await titulosPorPosicion(todo)).toEqual([]);
    expect(await titulosPorPosicion(backlog)).toEqual(["b-0", "b-1"]);
    await expectColumnaDensa(backlog);
  });

  it("el registro de auditoria trae la tarea ENTERA en before_data (5.2, CT-10)", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "la de antes" });
    const tarea = await sembrarTarea({
      boardId: tablero.id,
      columnKey: "TODO",
      title: "Revisar HU-25",
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      dueDate: new Date("2026-09-11T00:00:00.000Z"),
    });

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(204);

    const registro = await ultimoRegistro();

    expect(registro).toMatchObject({
      action: "DELETE",
      entity_type: "task",
      entity_id: tarea.id,
      actor_type: "API",
      // 6.1: el request_id del registro es el mismo X-Request-Id que viajo en la
      // cabecera, y en un 204 es lo unico que permite correlacionarlos.
      request_id: respuesta.headers.get("X-Request-Id"),
    });
    expect(registro?.after_data).toBeNull();

    // ENTERA: los diez campos de la tarea, no solo su id. Despues del DELETE la
    // fila ya no esta, asi que un registro que no diga que se perdio no sirve
    // para reconstruir nada.
    expect(registro?.before_data).toEqual({
      id: tarea.id,
      board_id: tablero.id,
      column_id: todo,
      title: "Revisar HU-25",
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      due_date: "2026-09-11",
      position: 1,
      created_at: tarea.createdAt.toISOString(),
      updated_at: tarea.updatedAt.toISOString(),
    });
  });

  it("404 al borrar dos veces: el segundo no es un 500", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "t" });

    const primera = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
      contextoDeRuta(tarea.id),
    );

    expect(primera.status).toBe(204);

    const segunda = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
      contextoDeRuta(tarea.id),
    );

    // Borrar algo que ya no esta y borrar algo que nunca existio son el mismo
    // estado, y tienen la misma respuesta.
    expect(segunda.status).toBe(404);
    expect((await leerError(segunda)).error.code).toBe("TASK_NOT_FOUND");
  });

  it("404 con un id que no existe", async () => {
    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${UUID_INEXISTENTE}`, clave: claveDelete }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("TASK_NOT_FOUND");
  });

  it("400 con un id que no es UUID", async () => {
    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: "/api/tasks/no-es-uuid", clave: claveDelete }),
      contextoDeRuta("no-es-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin clave, y la tarea sigue estando", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "Intacta" });

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}` }),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect(await leerTarea(tarea.id)).toBeDefined();
  });

  it("403 con una clave write y 204 con una clave delete sobre la misma tarea (CT-08)", async () => {
    // La contramedida que la 7.2 elige para REST es un scope APARTE: escribir no
    // habilita a borrar. Los dos casos van juntos en un solo test para que se lea
    // que lo unico que cambia entre el 403 y el 204 es la clave.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "queda" });
    const tarea = await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "se va" });

    const negada = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveWrite }),
      contextoDeRuta(tarea.id),
    );

    expect(negada.status).toBe(403);
    expect((await leerError(negada)).error.details).toEqual({
      required_scope: "delete",
      granted_scopes: ["write"],
    });
    // CT-08: no altera datos.
    expect(await titulosPorPosicion(todo)).toEqual(["queda", "se va"]);

    const concedida = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveDelete }),
      contextoDeRuta(tarea.id),
    );

    expect(concedida.status).toBe(204);
    expect(await titulosPorPosicion(todo)).toEqual(["queda"]);
  });
});
