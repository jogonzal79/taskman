import type { ResultadoDeMovimiento } from "@taskman/contracts";
import type { BoardDetail, CorePort, Task } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as mover } from "../app/api/tasks/[id]/move/route.js";
import {
  connectDb,
  contextoDeRuta,
  ctx,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * Contrato REST de POST /api/tasks/{id}/move (6.2, 6.3.3, RF-07 y RF-08).
 *
 * Mismo enfoque que el resto de la suite: el handler se importa y se invoca con
 * un `Request` armado a mano y con el contexto de ruta que le pasaria Next. Ver
 * el comentario de cabecera de `boards.test.ts` para el razonamiento completo,
 * incluido el de por que cada caso usa una clave con exactamente el scope que
 * necesita.
 *
 * ACA HAY DOS COSAS DISTINTAS QUE COMPROBAR, y el archivo las separa:
 *
 *   1. Que el orden que queda EN LA BASE sea el correcto. Se lee por SQL, y
 *      siempre COMPLETO: la densidad sola no detecta una permutacion, porque
 *      `rewriteTaskPositions` asigna la position desde la ordinalidad del array
 *      que recibe, asi que cualquier permutacion que se le pase produce una
 *      secuencia densa 0..n-1.
 *   2. Que el `affected_columns` de la RESPUESTA sea ese mismo orden. Se
 *      compara contra lo que devuelve SQL y no contra lo que esperabamos: es lo
 *      que la UI usa para reconciliar su estado optimista sin volver a
 *      consultar (9.2), asi que un orden inventado en el adaptador no se veria
 *      hasta que alguien recargue la pagina.
 *
 * Las pruebas de concurrencia de la 10.1 NO estan aca: son su propio paso.
 */

const UUID_INEXISTENTE = "11111111-2222-4333-8444-555555555555";

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveWrite: string;

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
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

/** `titulos` tareas al final de la columna, en ese orden. */
async function sembrarTareas(
  boardId: string,
  columnKey: string,
  titulos: readonly string[],
): Promise<Map<string, Task>> {
  const porTitulo = new Map<string, Task>();
  for (const title of titulos) {
    porTitulo.set(title, await taskman.createTask({ boardId, columnKey, title }, ctx()));
  }
  return porTitulo;
}

/**
 * Los ids de las tareas de una columna en orden de position, leidos de la base.
 * Es la forma que tiene `task_order` en la respuesta, asi que las dos se
 * comparan directo.
 */
async function ordenPorSql(columnId: string): Promise<string[]> {
  const filas = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM task WHERE column_id = $1::uuid ORDER BY position`,
    [columnId],
  );
  return filas.rows.map((fila) => fila.id);
}

/** Lo mismo pero por titulo, para que las aserciones se puedan leer. */
async function titulosPorSql(columnId: string): Promise<string[]> {
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

/**
 * `affected_columns` contra la base, columna por columna.
 *
 * El valor esperado se CONSTRUYE leyendo SQL, no se escribe a mano: lo que hay
 * que probar no es que el orden sea el que preveiamos —eso lo prueban las
 * aserciones de orden de cada caso— sino que la respuesta y la base digan lo
 * mismo. Escribirlo a mano dejaria pasar el caso en que las dos estan mal.
 */
async function expectAffectedColumnsIgualALaBase(
  cuerpo: ResultadoDeMovimiento,
  columnasEsperadas: readonly string[],
): Promise<void> {
  const esperado = [];
  for (const columnId of columnasEsperadas) {
    esperado.push({ column_id: columnId, task_order: await ordenPorSql(columnId) });
  }
  expect(cuerpo.affected_columns).toEqual(esperado);
}

function pedido(taskId: string, cuerpo: unknown, clave?: string): Request {
  return peticion({
    metodo: "POST",
    ruta: `/api/tasks/${taskId}/move`,
    ...(clave === undefined ? {} : { clave }),
    cuerpo,
  });
}

describe("POST /api/tasks/{id}/move", () => {
  it("200 entre columnas a una position intermedia: las dos quedan densas y en orden", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const done = porKey(tablero, "DONE");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1", "t-2", "t-3"]);
    await sembrarTareas(tablero.id, "DONE", ["d-0", "d-1", "d-2"]);

    const tarea = enTodo.get("t-1");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo t-1.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: done, position: 1 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<ResultadoDeMovimiento>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual([
      "affected_columns",
      "from_column_id",
      "task",
      "to_column_id",
    ]);
    expect(cuerpo.from_column_id).toBe(todo);
    expect(cuerpo.to_column_id).toBe(done);
    expect(cuerpo.task).toMatchObject({ id: tarea.id, column_id: done, position: 1 });

    // El ORDEN COMPLETO de las dos columnas, no solo la densidad: la densidad
    // sola no distingue una permutacion.
    expect(await titulosPorSql(todo)).toEqual(["t-0", "t-2", "t-3"]);
    expect(await titulosPorSql(done)).toEqual(["d-0", "t-1", "d-1", "d-2"]);
    await expectColumnaDensa(todo);
    await expectColumnaDensa(done);
  });

  it("200 hacia atras dentro de la misma columna (mismo algoritmo, 5.4)", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["a", "b", "c", "d", "e"]);

    const tarea = enTodo.get("e");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo e.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: todo, position: 1 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect(await titulosPorSql(todo)).toEqual(["a", "e", "b", "c", "d"]);
    await expectColumnaDensa(todo);
  });

  it("200 hacia adelante dentro de la misma columna", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["a", "b", "c", "d", "e"]);

    const tarea = enTodo.get("a");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo a.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: todo, position: 3 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    // La position se interpreta sobre la columna YA SIN la tarea movida, asi
    // que el indice pedido es el indice FINAL: [b,c,d] y `a` en la 3.
    expect(await titulosPorSql(todo)).toEqual(["b", "c", "d", "a", "e"]);
    expect((await leerJson<ResultadoDeMovimiento>(respuesta)).task.position).toBe(3);
    await expectColumnaDensa(todo);

    // Y de vuelta al principio: el mismo algoritmo en el otro sentido deja el
    // orden original.
    const vuelta = await mover(
      pedido(tarea.id, { column_id: todo, position: 0 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(vuelta.status).toBe(200);
    expect(await titulosPorSql(todo)).toEqual(["a", "b", "c", "d", "e"]);
    await expectColumnaDensa(todo);
  });

  it('200 con position "end": la tarea queda ultima', async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const done = porKey(tablero, "DONE");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);
    await sembrarTareas(tablero.id, "DONE", ["d-0", "d-1"]);

    const tarea = enTodo.get("t-0");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo t-0.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: done, position: "end" }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<ResultadoDeMovimiento>(respuesta)).task.position).toBe(2);
    expect(await titulosPorSql(done)).toEqual(["d-0", "d-1", "t-0"]);
  });

  it("200 con una position MAYOR que el tamano de la columna destino: se ajusta al final (5.2)", async () => {
    // La 5.2 lo pide explicitamente: "una posicion mayor que el tamano de la
    // columna destino se ajusta al final en lugar de fallar", porque el agente
    // que calcula mal el indice obtiene un resultado util y no un error.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const done = porKey(tablero, "DONE");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);
    await sembrarTareas(tablero.id, "DONE", ["d-0", "d-1"]);

    const tarea = enTodo.get("t-0");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo t-0.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: done, position: 99 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<ResultadoDeMovimiento>(respuesta);

    // 2 y no 99: la columna queda densa igual, sin hueco entre la 1 y la 99.
    expect(cuerpo.task.position).toBe(2);
    expect(await titulosPorSql(done)).toEqual(["d-0", "d-1", "t-0"]);
    await expectColumnaDensa(done);
  });

  /**
   * El criterio que decide el paso: la respuesta tiene que decir lo MISMO que
   * la base. El valor esperado se construye leyendo SQL.
   */
  describe("affected_columns es el orden final autoritativo (6.3.3, 9.2)", () => {
    it("entre columnas: trae origen y destino, los dos iguales a la base", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const done = porKey(tablero, "DONE");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1", "t-2"]);
      await sembrarTareas(tablero.id, "DONE", ["d-0", "d-1"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: done, position: 1 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(200);

      const cuerpo = await leerJson<ResultadoDeMovimiento>(respuesta);

      expect(cuerpo.affected_columns).toHaveLength(2);
      // Origen primero y destino despues, como el ejemplo de la 6.3.3.
      expect(cuerpo.affected_columns.map((columna) => columna.column_id)).toEqual([todo, done]);
      await expectAffectedColumnsIgualALaBase(cuerpo, [todo, done]);

      // Y que ese orden no sea trivialmente el de antes: la tarea movida esta
      // en el destino y no en el origen.
      expect(cuerpo.affected_columns[0]?.task_order).not.toContain(tarea.id);
      expect(cuerpo.affected_columns[1]?.task_order[1]).toBe(tarea.id);
    });

    it("intracolumna: trae UNA sola entrada, igual a la base", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["a", "b", "c", "d"]);

      const tarea = enTodo.get("d");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo d.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: todo, position: 0 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(200);

      const cuerpo = await leerJson<ResultadoDeMovimiento>(respuesta);

      // UNA, no dos: origen y destino son la misma columna, y repetirla daria
      // dos entradas con el mismo contenido que un cliente tendria que
      // deduplicar. `from_column_id` y `to_column_id` ya dicen que fue
      // intracolumna.
      expect(cuerpo.affected_columns).toHaveLength(1);
      expect(cuerpo.from_column_id).toBe(todo);
      expect(cuerpo.to_column_id).toBe(todo);
      await expectAffectedColumnsIgualALaBase(cuerpo, [todo]);
      expect(cuerpo.affected_columns[0]?.task_order[0]).toBe(tarea.id);
    });

    it('con position "end" tambien coincide con la base', async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const done = porKey(tablero, "DONE");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);
      await sembrarTareas(tablero.id, "DONE", ["d-0"]);

      const tarea = enTodo.get("t-1");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-1.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: done, position: "end" }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(200);
      await expectAffectedColumnsIgualALaBase(await leerJson<ResultadoDeMovimiento>(respuesta), [
        todo,
        done,
      ]);
    });
  });

  describe("referencia a la columna destino (6.3.3)", () => {
    it("200 con column_key en vez de column_id", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const enProgreso = porKey(tablero, "IN_PROGRESS");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_key: "IN_PROGRESS", position: "end" }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(200);

      const cuerpo = await leerJson<ResultadoDeMovimiento>(respuesta);

      // La resolucion es del nucleo, la misma `resolverColumna` del create: por
      // key y por id se mueve igual sin que el borde lo sepa.
      expect(cuerpo.to_column_id).toBe(enProgreso);
      expect(await titulosPorSql(enProgreso)).toEqual(["t-0"]);
    });

    it("409 COLUMN_NOT_IN_BOARD con una columna de OTRO tablero", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Propio" });
      const ajeno = await sembrarTablero(taskman, { name: "Ajeno" });
      const todo = porKey(tablero, "TODO");
      const doneAjena = porKey(ajeno, "DONE");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: doneAjena, position: 0 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      // 409 y no 404: la columna existe, lo que falla es su relacion con la
      // tarea. Es la fila COLUMN_NOT_IN_BOARD de la 6.4.
      expect(respuesta.status).toBe(409);
      expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_IN_BOARD");
      // La tarea no se movio, y la columna ajena sigue vacia.
      expect(await titulosPorSql(todo)).toEqual(["t-0"]);
      expect(await titulosPorSql(doneAjena)).toEqual([]);
    });

    it("404 COLUMN_NOT_FOUND con una key que el tablero no tiene", async () => {
      const tablero = await sembrarTablero(taskman, {
        name: "Sin DONE",
        columns: [
          { name: "Por hacer", key: "TODO" },
          { name: "En curso", key: "IN_PROGRESS" },
        ],
      });
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_key: "DONE", position: 0 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
    });
  });

  it("registra la auditoria MOVE con la ubicacion de las dos puntas (7.4)", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const done = porKey(tablero, "DONE");
    const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);
    await sembrarTareas(tablero.id, "DONE", ["d-0"]);

    const tarea = enTodo.get("t-1");
    if (tarea === undefined) {
      throw new Error("La siembra no dejo t-1.");
    }

    const respuesta = await mover(
      pedido(tarea.id, { column_id: done, position: 0 }, claveWrite),
      contextoDeRuta(tarea.id),
    );

    expect(respuesta.status).toBe(200);

    const filas = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before_data: Record<string, unknown> | null;
      after_data: Record<string, unknown> | null;
      actor_type: string;
      request_id: string | null;
    }>(
      `SELECT action, entity_type, entity_id, before_data, after_data,
              actor_type::text AS actor_type, request_id
         FROM audit_log ORDER BY id DESC LIMIT 1`,
    );
    const registro = filas.rows[0];

    expect(registro).toMatchObject({
      action: "MOVE",
      entity_type: "task",
      entity_id: tarea.id,
      actor_type: "API",
      request_id: respuesta.headers.get("X-Request-Id"),
    });
    // 7.4: `{ column_id, position }` en las dos puntas.
    expect(registro?.before_data).toEqual({ column_id: todo, position: 1 });
    expect(registro?.after_data).toEqual({ column_id: done, position: 0 });
  });

  describe("entrada invalida", () => {
    it("400 con una position negativa, y la tarea no se mueve", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);

      const tarea = enTodo.get("t-1");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-1.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: todo, position: -1 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      // La para el `min(0)` del esquema, antes de llegar al nucleo. El nucleo
      // tiene su propia guarda —INVALID_ORDER, tambien 400— pero la del borde
      // llega primero y dice cual es el campo.
      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await titulosPorSql(todo)).toEqual(["t-0", "t-1"]);
    });

    it("400 con un cuerpo sin columna destino", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { position: 0 }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      // 400 y no el COLUMN_NOT_FOUND 404 que devolveria el nucleo: un cuerpo
      // incompleto no es un recurso que no existe.
      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un cuerpo sin position", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const done = porKey(tablero, "DONE");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: done }, claveWrite),
        contextoDeRuta(tarea.id),
      );

      // La 6.3.3 la escribe en sus dos ejemplos y no documenta ningun valor por
      // defecto, a diferencia de la 6.3.1 con la del create.
      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("404 con una tarea que no existe", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await mover(
        pedido(UUID_INEXISTENTE, { column_id: porKey(tablero, "DONE"), position: 0 }, claveWrite),
        contextoDeRuta(UUID_INEXISTENTE),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("TASK_NOT_FOUND");
    });

    it("400 con un id de tarea que no es UUID", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await mover(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks/no-es-uuid/move",
          clave: claveWrite,
          cuerpo: { column_id: porKey(tablero, "DONE"), position: 0 },
        }),
        contextoDeRuta("no-es-uuid"),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un cuerpo que no es JSON", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0"]);

      const tarea = enTodo.get("t-0");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-0.");
      }

      const respuesta = await mover(
        peticion({
          metodo: "POST",
          ruta: `/api/tasks/${tarea.id}/move`,
          clave: claveWrite,
          cuerpoCrudo: "{no es json",
        }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("autorizacion", () => {
    it("401 sin clave, y no mueve nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);

      const tarea = enTodo.get("t-1");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-1.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: porKey(tablero, "DONE"), position: 0 }),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
      expect(await titulosPorSql(todo)).toEqual(["t-0", "t-1"]);
    });

    it("403 con una clave sin scope write, y no mueve nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const todo = porKey(tablero, "TODO");
      const done = porKey(tablero, "DONE");
      const enTodo = await sembrarTareas(tablero.id, "TODO", ["t-0", "t-1"]);

      const tarea = enTodo.get("t-1");
      if (tarea === undefined) {
        throw new Error("La siembra no dejo t-1.");
      }

      const respuesta = await mover(
        pedido(tarea.id, { column_id: done, position: 0 }, claveRead),
        contextoDeRuta(tarea.id),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "write",
        granted_scopes: ["read"],
      });
      expect(await titulosPorSql(todo)).toEqual(["t-0", "t-1"]);
      expect(await titulosPorSql(done)).toEqual([]);
    });
  });
});
