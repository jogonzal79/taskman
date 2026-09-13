import type { ColumnaConOrden } from "@taskman/contracts";
import type { BoardDetail, CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DELETE as eliminar, PATCH as actualizar } from "../app/api/columns/[id]/route";
import {
  connectDb,
  contarFilas,
  contextoDeRuta,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  sembrarTareas,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de PATCH y DELETE /api/columns/{id} (6.2).
 *
 * Mismo enfoque que el resto de la suite: los handlers se importan y se invocan
 * con un `Request` armado a mano y con el contexto de ruta que les pasaria Next.
 * Ver el comentario de cabecera de `boards.test.ts` para el razonamiento
 * completo, incluido el de por que cada caso usa una clave con exactamente el
 * scope que necesita.
 *
 * Todo lo que es ORDEN se comprueba por SQL y nunca por la respuesta: lo que hay
 * que verificar es el estado de la base tras reindexar, y leerlo del cuerpo que
 * el adaptador acaba de construir probaria que se copia a si mismo.
 */

const CLAVES_COLUMNA = [
  "board_id",
  "created_at",
  "id",
  "key",
  "name",
  "position",
  "updated_at",
];

const POR_DEFECTO = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE"];

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

/** El id de una columna del tablero sembrado, por su key. */
function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

/** Las keys del tablero ordenadas por position, leidas de la base. */
async function keysPorPosicion(boardId: string): Promise<string[]> {
  const filas = await client.query<{ key: string }>(
    `SELECT key FROM board_column WHERE board_id = $1::uuid ORDER BY position`,
    [boardId],
  );
  return filas.rows.map((fila) => fila.key);
}

/** El orden de columnas del tablero es exactamente 0..n-1 (ADR-004). */
async function expectTableroDenso(boardId: string): Promise<void> {
  const filas = await client.query<{ position: number }>(
    `SELECT position FROM board_column WHERE board_id = $1::uuid ORDER BY position`,
    [boardId],
  );
  const posiciones = filas.rows.map((fila) => fila.position);
  expect(posiciones).toEqual(posiciones.map((_, indice) => indice));
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

/** Cada tarea del tablero con la key de su columna y su position. */
async function ubicacionDeTareas(
  boardId: string,
): Promise<Array<{ title: string; key: string; position: number }>> {
  const filas = await client.query<{ title: string; key: string; position: number }>(
    `SELECT t.title, c.key, t.position
       FROM task t JOIN board_column c ON c.id = t.column_id
      WHERE t.board_id = $1::uuid
      ORDER BY c.key, t.position`,
    [boardId],
  );
  return filas.rows;
}

/** La fila de `board_column`, leida de la base por su id. */
async function leerColumna(
  columnId: string,
): Promise<{ name: string; key: string; position: number } | undefined> {
  const filas = await client.query<{ name: string; key: string; position: number }>(
    `SELECT name, key, position FROM board_column WHERE id = $1::uuid`,
    [columnId],
  );
  return filas.rows[0];
}

describe("PATCH /api/columns/{id}", () => {
  it("200 renombra: cambia el name y NO la key ni la position", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: { name: "Pendiente" },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<ColumnaConOrden>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(["column", "columns"]);
    expect(Object.keys(cuerpo.column).sort()).toEqual(CLAVES_COLUMNA);
    expect(cuerpo.column.name).toBe("Pendiente");
    // La key es estable por diseño: los agentes resuelven referencias con ella.
    expect(cuerpo.column.key).toBe("TODO");
    expect(cuerpo.column.position).toBe(1);

    // Y en la base, no solo en la respuesta.
    expect(await leerColumna(todo)).toEqual({
      name: "Pendiente",
      key: "TODO",
      position: 1,
    });
    // Renombrar no toca el orden del tablero.
    expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
  });

  it("200 reordena hacia atras y el tablero queda denso", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const done = porKey(tablero, "DONE");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${done}`,
        clave: claveWrite,
        cuerpo: { position: 0 },
      }),
      contextoDeRuta(done),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<ColumnaConOrden>(respuesta);

    expect(cuerpo.column.position).toBe(0);
    // El estado real, por SQL.
    expect(await keysPorPosicion(tablero.id)).toEqual([
      "DONE",
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
    ]);
    await expectTableroDenso(tablero.id);

    // Y la respuesta trae el orden FINAL: es la razon de devolver `columns`
    // ademas de `column`.
    expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
      "DONE",
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
    ]);
    expect(cuerpo.columns.map((columna) => columna.position)).toEqual([0, 1, 2, 3]);
  });

  it("200 reordena hacia adelante y el tablero queda denso", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const backlog = porKey(tablero, "BACKLOG");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${backlog}`,
        clave: claveWrite,
        cuerpo: { position: 2 },
      }),
      contextoDeRuta(backlog),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<ColumnaConOrden>(respuesta)).column.position).toBe(2);
    expect(await keysPorPosicion(tablero.id)).toEqual([
      "TODO",
      "IN_PROGRESS",
      "BACKLOG",
      "DONE",
    ]);
    await expectTableroDenso(tablero.id);
  });

  it('200 con position "end" manda la columna al final', async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const backlog = porKey(tablero, "BACKLOG");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${backlog}`,
        clave: claveWrite,
        cuerpo: { position: "end" },
      }),
      contextoDeRuta(backlog),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<ColumnaConOrden>(respuesta)).column.position).toBe(3);
    expect(await keysPorPosicion(tablero.id)).toEqual([
      "TODO",
      "IN_PROGRESS",
      "DONE",
      "BACKLOG",
    ]);
    await expectTableroDenso(tablero.id);
  });

  it("200 con una position mayor que el tablero se ajusta al final en vez de fallar", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const backlog = porKey(tablero, "BACKLOG");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${backlog}`,
        clave: claveWrite,
        cuerpo: { position: 99 },
      }),
      contextoDeRuta(backlog),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<ColumnaConOrden>(respuesta)).column.position).toBe(3);
    await expectTableroDenso(tablero.id);
  });

  it("200 renombra y reordena en la misma llamada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const done = porKey(tablero, "DONE");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${done}`,
        clave: claveWrite,
        cuerpo: { name: "Terminado", position: 0 },
      }),
      contextoDeRuta(done),
    );

    expect(respuesta.status).toBe(200);
    expect(await leerColumna(done)).toEqual({
      name: "Terminado",
      key: "DONE",
      position: 0,
    });
    await expectTableroDenso(tablero.id);
  });

  it("reordenar NO mueve las tareas de columna ni de position", async () => {
    // Reindexar columnas reescribe `board_column.position`, no `task.position`
    // ni `task.column_id`: una tarea que estaba en TODO sigue en TODO, en su
    // lugar, aunque TODO cambie de posicion en el tablero.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 3,
    });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "DONE",
      prefijo: "d",
      cantidad: 2,
    });

    const antes = await ubicacionDeTareas(tablero.id);
    const done = porKey(tablero, "DONE");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${done}`,
        clave: claveWrite,
        cuerpo: { position: 0 },
      }),
      contextoDeRuta(done),
    );

    expect(respuesta.status).toBe(200);
    expect(await keysPorPosicion(tablero.id)).toEqual([
      "DONE",
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
    ]);

    // Ni una tarea cambio de columna ni de position.
    expect(await ubicacionDeTareas(tablero.id)).toEqual(antes);
    expect(await titulosPorPosicion(porKey(tablero, "TODO"))).toEqual(["t-0", "t-1", "t-2"]);
    expect(await titulosPorPosicion(done)).toEqual(["d-0", "d-1"]);
  });

  it("200 con el cuerpo vacio no cambia nada y no deja registro de auditoria", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");
    const auditoriaAntes = await contarFilas(client, "audit_log");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: {},
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(200);
    expect(await leerColumna(todo)).toEqual({ name: "Por hacer", key: "TODO", position: 1 });
    // 5.2: sin cambio efectivo no hay escritura ni registro, y lo resuelve el
    // nucleo, no el borde.
    expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
  });

  it("404 COLUMN_NOT_FOUND con un id que no existe", async () => {
    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${UUID_INEXISTENTE}`,
        clave: claveWrite,
        cuerpo: { name: "Da igual" },
      }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("400 con un id que no es UUID, sin llegar a consultar la base", async () => {
    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: "/api/columns/no-soy-un-uuid",
        clave: claveWrite,
        cuerpo: { name: "Da igual" },
      }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("400 con key: no es un campo editable", async () => {
    // Las keys son estables por diseño (8.3.1): cambiarlas romperia en silencio
    // a los agentes que resuelven referencias con ellas.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: { key: "PENDIENTE" },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("VALIDATION_ERROR");
    expect(cuerpo.error.hint).toContain("key");
    expect((await leerColumna(todo))?.key).toBe("TODO");
  });

  it("400 con board_id: tampoco se mueve una columna de tablero por aca", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const otro = await sembrarTablero(taskman, { name: "Otro" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: { board_id: otro.id },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await keysPorPosicion(otro.id)).toEqual(POR_DEFECTO);
  });

  it("400 con un name de solo espacios", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: { name: "   " },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect((await leerColumna(todo))?.name).toBe("Por hacer");
  });

  it("400 con una position negativa", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpo: { position: -1 },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
  });

  it("400 con un cuerpo que no es JSON", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveWrite,
        cuerpoCrudo: "{ esto no cierra",
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization, y no modifica nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        cuerpo: { name: "Modificado" },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect((await leerColumna(todo))?.name).toBe("Por hacer");
  });

  it("403 con una clave sin scope write, y no modifica nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/columns/${todo}`,
        clave: claveRead,
        cuerpo: { name: "Modificado" },
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(403);
    expect((await leerError(respuesta)).error.details).toEqual({
      required_scope: "write",
      granted_scopes: ["read"],
    });
    expect((await leerColumna(todo))?.name).toBe("Por hacer");
  });
});

describe("DELETE /api/columns/{id}", () => {
  it("204 con una columna VACIA sin reassign_to, y el tablero queda denso", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/columns/${todo}`, clave: claveDelete }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(204);
    expect(await respuesta.text()).toBe("");
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);

    expect(await leerColumna(todo)).toBeUndefined();
    expect(await keysPorPosicion(tablero.id)).toEqual(["BACKLOG", "IN_PROGRESS", "DONE"]);
    await expectTableroDenso(tablero.id);
  });

  it("409 COLUMN_NOT_EMPTY con tareas y sin reassign_to: no borra ni mueve nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });

    const todo = porKey(tablero, "TODO");
    const antes = await ubicacionDeTareas(tablero.id);

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/columns/${todo}`, clave: claveDelete }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(409);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("COLUMN_NOT_EMPTY");
    expect(cuerpo.error.details).toMatchObject({ columnId: todo, taskCount: 2 });
    expect(cuerpo.error.hint).toContain("reassignTo");

    // Nada se borro ni se movio.
    expect(await leerColumna(todo)).not.toBeUndefined();
    expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    expect(await ubicacionDeTareas(tablero.id)).toEqual(antes);
    expect(await contarFilas(client, "task")).toBe(2);
  });

  it("204 con reassign_to: las tareas quedan al FINAL del destino, en su orden, y el destino queda denso", async () => {
    // El caso que decide el paso. El destino ya tiene tareas propias, asi que
    // "al final" y "al principio" dan ordenes distintos: si las reasignadas
    // entraran primero, o intercaladas, este test lo ve.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "IN_PROGRESS",
      prefijo: "ya-estaba",
      cantidad: 2,
    });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "se-muda",
      cantidad: 3,
    });

    const todo = porKey(tablero, "TODO");
    const inProgress = porKey(tablero, "IN_PROGRESS");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=${inProgress}`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(204);

    // El orden COMPLETO del destino, no el recuento: las dos que ya estaban
    // conservan su lugar y las tres que se mudaron van detras, en el orden en el
    // que estaban en TODO.
    expect(await titulosPorPosicion(inProgress)).toEqual([
      "ya-estaba-0",
      "ya-estaba-1",
      "se-muda-0",
      "se-muda-1",
      "se-muda-2",
    ]);
    await expectColumnaDensa(inProgress);

    // La columna se fue y el tablero quedo denso.
    expect(await leerColumna(todo)).toBeUndefined();
    expect(await keysPorPosicion(tablero.id)).toEqual(["BACKLOG", "IN_PROGRESS", "DONE"]);
    await expectTableroDenso(tablero.id);

    // Ninguna tarea se perdio por el camino.
    expect(await contarFilas(client, "task")).toBe(5);
  });

  it("204 con reassign_to a una columna destino VACIA", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "se-muda",
      cantidad: 2,
    });

    const todo = porKey(tablero, "TODO");
    const done = porKey(tablero, "DONE");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=${done}`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(204);
    expect(await titulosPorPosicion(done)).toEqual(["se-muda-0", "se-muda-1"]);
    await expectColumnaDensa(done);
  });

  it("409 COLUMN_NOT_IN_BOARD con reassign_to a una columna de OTRO tablero", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const otro = await sembrarTablero(taskman, { name: "Otro" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });

    const todo = porKey(tablero, "TODO");
    const ajena = porKey(otro, "DONE");
    const antes = await ubicacionDeTareas(tablero.id);

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=${ajena}`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(409);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("COLUMN_NOT_IN_BOARD");
    expect(cuerpo.error.details).toMatchObject({
      columnId: todo,
      reassignTo: ajena,
      boardId: tablero.id,
      reassignBoardId: otro.id,
    });

    // Ni se borro la columna ni viajo ninguna tarea al otro tablero.
    expect(await leerColumna(todo)).not.toBeUndefined();
    expect(await ubicacionDeTareas(tablero.id)).toEqual(antes);
    expect(await titulosPorPosicion(ajena)).toEqual([]);
  });

  it("409 INVALID_REASSIGN_TARGET con reassign_to a la columna que se esta borrando", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });

    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=${todo}`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(409);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("INVALID_REASSIGN_TARGET");
    expect(cuerpo.error.details).toMatchObject({ columnId: todo, reassignTo: todo });
    // Las tareas siguen donde estaban: no se "reasignaron a si mismas".
    expect(await titulosPorPosicion(todo)).toEqual(["t-0", "t-1"]);
  });

  it("404 COLUMN_NOT_FOUND con reassign_to a una columna que no existe", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 1,
    });

    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=${UUID_INEXISTENTE}`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
    expect(await leerColumna(todo)).not.toBeUndefined();
  });

  it("400 con un reassign_to que no es UUID, en vez de tratarlo como ausente", async () => {
    // Caer en "ausente" seria borrar con el comportamiento que RECHAZA tareas,
    // cuando quien llamo pidio explicitamente reasignarlas.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=no-soy-un-uuid`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await leerColumna(todo)).not.toBeUndefined();
  });

  it("400 con un reassign_to vacio", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${todo}?reassign_to=`,
        clave: claveDelete,
      }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await leerColumna(todo)).not.toBeUndefined();
  });

  it("404 COLUMN_NOT_FOUND con un id que no existe", async () => {
    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${UUID_INEXISTENTE}`,
        clave: claveDelete,
      }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("400 con un id que no es UUID", async () => {
    const respuesta = await eliminar(
      peticion({
        metodo: "DELETE",
        ruta: "/api/columns/no-soy-un-uuid",
        clave: claveDelete,
      }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("403 con una clave write y 204 con una clave delete sobre la misma columna", async () => {
    // La contramedida que la 7.2 elige para REST es un scope APARTE: escribir no
    // habilita a borrar. Los dos casos van juntos para que se lea que lo unico
    // que cambia entre el 403 y el 204 es la clave.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const negada = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/columns/${todo}`, clave: claveWrite }),
      contextoDeRuta(todo),
    );

    expect(negada.status).toBe(403);

    const cuerpo = await leerError(negada);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "delete",
      granted_scopes: ["write"],
    });
    // CT-08: no altera datos.
    expect(await leerColumna(todo)).not.toBeUndefined();

    const permitida = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/columns/${todo}`, clave: claveDelete }),
      contextoDeRuta(todo),
    );

    expect(permitida.status).toBe(204);
    expect(await leerColumna(todo)).toBeUndefined();
  });

  it("401 sin la cabecera Authorization, y no borra nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const todo = porKey(tablero, "TODO");

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/columns/${todo}` }),
      contextoDeRuta(todo),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect(await leerColumna(todo)).not.toBeUndefined();
    expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
  });
});
