import type { ListadoDeTableros, TableroDetallado } from "@taskman/contracts";
import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listar, POST as crear } from "../app/api/boards/route.js";
import {
  connectDb,
  contarFilas,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * Contrato REST de /api/boards (6.2), nivel "Contrato REST" de la 10.
 *
 * Los Route Handlers se IMPORTAN y se invocan con un `Request` armado a mano: no
 * hay servidor ni puerto. Lo que se ejercita es la cadena completa del
 * adaptador —`conAuth`, la validacion de entrada, el servicio, la validacion de
 * salida y el mapeo de errores de la 6.4— contra PostgreSQL real. Lo que NO se
 * ejercita es el ruteo de Next ni el bundler, y es deliberado: esa capa la cubre
 * `next build`, que ya corre dentro de `verify`.
 *
 * Las CLAVES de cada caso tienen exactamente el scope que hace falta y ninguno
 * mas, y hay un caso espejo con una clave que NO lo tiene. Los dos hacen falta:
 * el primero falla si alguien vuelve el endpoint mas restrictivo, el segundo si
 * alguien lo vuelve mas permisivo. Una clave con los tres scopes no detectaria
 * ni uno de los dos cambios.
 */

/** Las claves de `tablero` (contracts), escritas a mano a proposito. */
const CLAVES_TABLERO = ["created_at", "description", "id", "name", "updated_at"];

/** Las claves de `columnaDetallada`. */
const CLAVES_COLUMNA = [
  "board_id",
  "created_at",
  "id",
  "key",
  "name",
  "position",
  "task_count",
  "updated_at",
];

/** Las de `tableroDetallado`: un tablero mas columnas y recuento. */
const CLAVES_DETALLE = [...CLAVES_TABLERO, "columns", "task_count"].sort();

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
  // Las claves se emiten despues del TRUNCATE que las borra, en cada test: la
  // suite no depende de ninguna clave preexistente y se puede correr dos veces
  // seguidas sin tocar nada a mano.
  claveRead = await emitirClave(client, ["READ"]);
  claveWrite = await emitirClave(client, ["WRITE"]);
});

describe("GET /api/boards", () => {
  it("200 con los tableros, en snake_case y ordenados por nombre", async () => {
    await sembrarTablero(taskman, { name: "Beta" });
    await sembrarTablero(taskman, { name: "Alfa", description: "la primera" });

    const respuesta = await listar(peticion({ clave: claveRead }));

    expect(respuesta.status).toBe(200);
    // 6.1: toda respuesta lleva X-Request-Id, y un listado no se cachea.
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<ListadoDeTableros>(respuesta);

    expect(cuerpo.items.map((item) => item.name)).toEqual(["Alfa", "Beta"]);
    expect(cuerpo.next_cursor).toBeNull();
    // Las claves exactas, no un subconjunto: asi un campo en camelCase o uno
    // interno que se cuele hacen fallar esto y no pasan callados.
    expect(Object.keys(cuerpo).sort()).toEqual(["items", "next_cursor"]);
    expect(Object.keys(cuerpo.items[0] ?? {}).sort()).toEqual(CLAVES_TABLERO);
    expect(cuerpo.items[0]?.description).toBe("la primera");
    expect(cuerpo.items[1]?.description).toBeNull();
  });

  it("200 con lista vacia cuando no hay ningun tablero", async () => {
    const respuesta = await listar(peticion({ clave: claveRead }));

    expect(respuesta.status).toBe(200);
    expect(await leerJson<ListadoDeTableros>(respuesta)).toEqual({
      items: [],
      next_cursor: null,
    });
  });

  it("401 sin la cabecera Authorization, con el request_id del cuerpo igual al de la cabecera", async () => {
    const respuesta = await listar(peticion({}));

    expect(respuesta.status).toBe(401);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("UNAUTHENTICATED");
    // 6.1: el request_id del cuerpo es el que correlaciona con la cabecera.
    expect(cuerpo.error.request_id).toBe(respuesta.headers.get("X-Request-Id"));
  });

  it("401 con una clave que no existe", async () => {
    const respuesta = await listar(peticion({ clave: "tmk_live_noexisteestaclaveenlabase" }));

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
  });

  it("403 con una clave sin scope read", async () => {
    const respuesta = await listar(peticion({ clave: claveWrite }));

    expect(respuesta.status).toBe(403);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "read",
      granted_scopes: ["write"],
    });
  });

  it("400 con un limit que no es un numero, en vez de caer en el valor por defecto", async () => {
    const respuesta = await listar(peticion({ ruta: "/api/boards?limit=abc", clave: claveRead }));

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("400 con un limit por encima del maximo de la 6.1", async () => {
    const respuesta = await listar(peticion({ ruta: "/api/boards?limit=201", clave: claveRead }));

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/boards", () => {
  it("201 con las cuatro columnas por defecto de la 4.3, con sus keys y posiciones", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpo: { name: "Nuevo" } }),
    );

    expect(respuesta.status).toBe(201);

    const cuerpo = await leerJson<TableroDetallado>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_DETALLE);
    expect(cuerpo.name).toBe("Nuevo");
    expect(cuerpo.description).toBeNull();

    // La 4.3 fija el orden Y las keys: son el contrato con el que los agentes
    // resuelven referencias por nombre, asi que se comprueban las dos cosas.
    expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    expect(cuerpo.columns.map((columna) => columna.name)).toEqual([
      "Backlog",
      "Por hacer",
      "En progreso",
      "Completado",
    ]);
    expect(cuerpo.columns.map((columna) => columna.position)).toEqual([0, 1, 2, 3]);
    expect(cuerpo.columns.map((columna) => columna.task_count)).toEqual([0, 0, 0, 0]);
    expect(cuerpo.task_count).toBe(0);
    expect(Object.keys(cuerpo.columns[0] ?? {}).sort()).toEqual(CLAVES_COLUMNA);
    expect(cuerpo.columns.every((columna) => columna.board_id === cuerpo.id)).toBe(true);

    // Y quedaron en la base, no solo en la respuesta.
    expect(await contarFilas(client, "board")).toBe(1);
    expect(await contarFilas(client, "board_column")).toBe(4);
  });

  it("201 conserva la descripcion enviada", async () => {
    const respuesta = await crear(
      peticion({
        metodo: "POST",
        clave: claveWrite,
        cuerpo: { name: "Con descripcion", description: "algo" },
      }),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<TableroDetallado>(respuesta)).description).toBe("algo");
  });

  it("400 con un nombre vacio tras recortar los espacios", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpo: { name: "   " } }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("400 con un campo que el contrato no declara, en vez de ignorarlo", async () => {
    // `crearTablero` es strictObject: mandar columnas no queda ignorado en
    // silencio, es un 400 que dice que campo sobra.
    const respuesta = await crear(
      peticion({
        metodo: "POST",
        clave: claveWrite,
        cuerpo: { name: "Con columnas", columns: [{ key: "X", name: "X" }] },
      }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("400 con un cuerpo que no es JSON", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpoCrudo: "esto no es json" }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization, y no crea nada", async () => {
    const respuesta = await crear(peticion({ metodo: "POST", cuerpo: { name: "Anonimo" } }));

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("403 con una clave sin scope write, y no crea nada", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveRead, cuerpo: { name: "Solo lectura" } }),
    );

    expect(respuesta.status).toBe(403);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "write",
      granted_scopes: ["read"],
    });
    expect(await contarFilas(client, "board")).toBe(0);
  });
});
