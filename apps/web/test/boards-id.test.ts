import type { Tablero, TableroDetallado } from "@taskman/contracts";
import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DELETE as eliminar,
  GET as obtener,
  PATCH as actualizar,
} from "../app/api/boards/[id]/route";
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
 * Contrato REST de /api/boards/{id} (6.2): GET, PATCH y DELETE.
 *
 * Mismo enfoque que `boards.test.ts`: los handlers se importan y se invocan con
 * un `Request` armado a mano y con el contexto de ruta que les pasaria Next. Ver
 * ahi el razonamiento completo, incluido el de por que cada caso usa una clave
 * con exactamente el scope que necesita.
 */

const CLAVES_TABLERO = ["created_at", "description", "id", "name", "updated_at"];

const CLAVES_DETALLE = [...CLAVES_TABLERO, "columns", "task_count"].sort();

/** Un UUID valido que no existe en la base: el caso de 404, no el de 400. */
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

/** Lee la fila de `board` directo de la base, sin pasar por el borde. */
async function leerTablero(
  id: string,
): Promise<{ name: string; description: string | null } | undefined> {
  const filas = await client.query<{ name: string; description: string | null }>(
    `SELECT name, description FROM board WHERE id = $1::uuid`,
    [id],
  );
  return filas.rows[0];
}

describe("GET /api/boards/{id}", () => {
  it("200 con las columnas y el task_count de cada una", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Con tareas" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "BACKLOG",
      prefijo: "b",
      cantidad: 3,
    });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "DONE",
      prefijo: "d",
      cantidad: 1,
    });

    const respuesta = await obtener(
      peticion({ ruta: `/api/boards/${tablero.id}`, clave: claveRead }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<TableroDetallado>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_DETALLE);
    expect(cuerpo.id).toBe(tablero.id);
    expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    // Una columna sin tareas cuenta cero y no desaparece del resultado.
    expect(cuerpo.columns.map((columna) => columna.task_count)).toEqual([3, 0, 0, 1]);
    // El total es la suma y va aparte: esta respuesta no trae las tareas, asi
    // que el cliente no podria calcularlo.
    expect(cuerpo.task_count).toBe(4);
  });

  it("404 con un id que no existe", async () => {
    const respuesta = await obtener(
      peticion({ ruta: `/api/boards/${UUID_INEXISTENTE}`, clave: claveRead }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    // El codigo viene del nucleo y lo traduce el mapeo de la 6.4, no el handler.
    expect((await leerError(respuesta)).error.code).toBe("BOARD_NOT_FOUND");
  });

  it("400 con un id que no es UUID, sin llegar a consultar la base", async () => {
    // Sin esta validacion el id llegaria a PostgreSQL como texto y volveria como
    // un 22P02 del driver, indistinguible de un fallo real: seria un 500.
    const respuesta = await obtener(
      peticion({ ruta: "/api/boards/no-soy-un-uuid", clave: claveRead }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization", async () => {
    const respuesta = await obtener(
      peticion({ ruta: `/api/boards/${UUID_INEXISTENTE}` }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
  });

  it("403 con una clave sin scope read", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Privado" });

    const respuesta = await obtener(
      peticion({ ruta: `/api/boards/${tablero.id}`, clave: claveWrite }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(403);
    expect((await leerError(respuesta)).error.details).toEqual({
      required_scope: "read",
      granted_scopes: ["write"],
    });
  });
});

describe("PATCH /api/boards/{id}", () => {
  it("200 y una description AUSENTE conserva la que ya tenia", async () => {
    // El caso que protege el spread condicional del handler. Ausente y null son
    // DOS intenciones distintas, y esta es la primera: no tocar la descripcion.
    const tablero = await sembrarTablero(taskman, { name: "Antes", description: "la de antes" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpo: { name: "Despues" },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<Tablero>(respuesta);

    expect(cuerpo.name).toBe("Despues");
    expect(cuerpo.description).toBe("la de antes");
    // Y en la base, no solo en la respuesta.
    expect(await leerTablero(tablero.id)).toEqual({
      name: "Despues",
      description: "la de antes",
    });
  });

  it("200 y una description en null la borra", async () => {
    // La segunda intencion. Si el borde colapsara null y ausente en el mismo
    // valor, esto seria imposible de pedir.
    const tablero = await sembrarTablero(taskman, { name: "Antes", description: "la de antes" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpo: { description: null },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<Tablero>(respuesta);

    expect(cuerpo.description).toBeNull();
    // El nombre no se toca: el patch es parcial en los dos sentidos.
    expect(cuerpo.name).toBe("Antes");
    expect(await leerTablero(tablero.id)).toEqual({ name: "Antes", description: null });
  });

  it("200 devuelve el tablero SOLO, sin columnas ni recuentos", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Sin columnas en la salida" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpo: { name: "Renombrado" },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(200);
    // A diferencia del GET y del POST: un PATCH de nombre y descripcion no toca
    // ninguna columna, y los recuentos serian de otro instante que el tablero.
    expect(Object.keys(await leerJson<Tablero>(respuesta)).sort()).toEqual(CLAVES_TABLERO);
  });

  it("200 con el cuerpo vacio no cambia nada y no deja registro de auditoria", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Igual", description: "igual" });
    const auditoriaAntes = await contarFilas(client, "audit_log");

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpo: {},
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(200);
    expect(await leerTablero(tablero.id)).toEqual({ name: "Igual", description: "igual" });
    // 5.2: sin cambio efectivo no hay escritura ni registro. El borde no
    // intercepta el caso, lo resuelve el nucleo.
    expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
  });

  it("400 con name en null: un tablero sin nombre no existe", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Con nombre" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpo: { name: null },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect((await leerTablero(tablero.id))?.name).toBe("Con nombre");
  });

  it("400 con un cuerpo que no es JSON", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Intacto" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveWrite,
        cuerpoCrudo: "{ esto no cierra",
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("400 con un id que no es UUID", async () => {
    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: "/api/boards/no-soy-un-uuid",
        clave: claveWrite,
        cuerpo: { name: "Da igual" },
      }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("404 con un id que no existe", async () => {
    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${UUID_INEXISTENTE}`,
        clave: claveWrite,
        cuerpo: { name: "Da igual" },
      }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("BOARD_NOT_FOUND");
  });

  it("401 sin la cabecera Authorization, y no modifica nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Intacto" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        cuerpo: { name: "Modificado" },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect((await leerTablero(tablero.id))?.name).toBe("Intacto");
  });

  it("403 con una clave sin scope write, y no modifica nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Intacto" });

    const respuesta = await actualizar(
      peticion({
        metodo: "PATCH",
        ruta: `/api/boards/${tablero.id}`,
        clave: claveRead,
        cuerpo: { name: "Modificado" },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(403);
    expect((await leerError(respuesta)).error.details).toEqual({
      required_scope: "write",
      granted_scopes: ["read"],
    });
    expect((await leerTablero(tablero.id))?.name).toBe("Intacto");
  });
});

describe("DELETE /api/boards/{id}", () => {
  it("204 sin cuerpo, con X-Request-Id", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Para borrar" });

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${tablero.id}`, clave: claveDelete }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(204);
    expect(await respuesta.text()).toBe("");
    // Es lo UNICO que devuelve un 204, y sin el no habria con que correlacionar
    // el borrado con su registro de auditoria (6.1).
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(await leerTablero(tablero.id)).toBeUndefined();
  });

  it("204 y la cascada se lleva las columnas y las tareas", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Con contenido" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "BACKLOG",
      prefijo: "b",
      cantidad: 2,
    });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 1,
    });

    expect(await contarFilas(client, "board_column")).toBe(4);
    expect(await contarFilas(client, "task")).toBe(3);

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${tablero.id}`, clave: claveDelete }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(204);
    expect(await contarFilas(client, "board")).toBe(0);
    expect(await contarFilas(client, "board_column")).toBe(0);
    expect(await contarFilas(client, "task")).toBe(0);
  });

  it("403 con una clave write y 204 con una clave delete sobre el mismo tablero", async () => {
    // La contramedida que la 7.2 elige para REST es un scope APARTE: escribir no
    // habilita a borrar. Los dos casos van juntos en un solo test para que se lea
    // que lo unico que cambia entre el 403 y el 204 es la clave.
    const tablero = await sembrarTablero(taskman, { name: "Solo con delete" });

    const negada = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${tablero.id}`, clave: claveWrite }),
      contextoDeRuta(tablero.id),
    );

    expect(negada.status).toBe(403);

    const cuerpo = await leerError(negada);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "delete",
      granted_scopes: ["write"],
    });
    // CT-08: no altera datos.
    expect(await leerTablero(tablero.id)).not.toBeUndefined();

    const permitida = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${tablero.id}`, clave: claveDelete }),
      contextoDeRuta(tablero.id),
    );

    expect(permitida.status).toBe(204);
    expect(await leerTablero(tablero.id)).toBeUndefined();
  });

  it("404 con un id que no existe, igual que borrar dos veces", async () => {
    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${UUID_INEXISTENTE}`, clave: claveDelete }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("BOARD_NOT_FOUND");
  });

  it("400 con un id que no es UUID", async () => {
    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: "/api/boards/no-soy-un-uuid", clave: claveDelete }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization, y no borra nada", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Intacto" });

    const respuesta = await eliminar(
      peticion({ metodo: "DELETE", ruta: `/api/boards/${tablero.id}` }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect(await leerTablero(tablero.id)).not.toBeUndefined();
  });
});
