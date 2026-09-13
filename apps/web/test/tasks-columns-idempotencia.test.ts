import { createHash } from "node:crypto";

import type { ColumnaConOrden, Tarea, TableroDetallado } from "@taskman/contracts";
import { prefijoDe, type BoardDetail, type CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as crearColumna } from "../app/api/boards/[id]/columns/route.js";
import { POST as crearTablero } from "../app/api/boards/route.js";
import { POST as crearTarea } from "../app/api/tasks/route.js";
import { CABECERA_CLAVE, CABECERA_REPLAY, hashDePeticion } from "../lib/idempotencia.js";
import {
  connectDb,
  contarFilas,
  contextoDeRuta,
  emitirClave,
  leerError,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * Idempotencia de la 6.5 en los otros dos POST: /api/tasks y
 * /api/boards/{id}/columns.
 *
 * El mecanismo es el MISMO que ya cubre `boards-idempotencia.test.ts` —la
 * canonicalizacion, el hash y los tres caminos no dependen del endpoint— asi que
 * aca no se vuelve a probar la canonicalizacion. Lo que se prueba es lo que SI
 * es propio de cada endpoint: que cada uno guarde y reproduzca SU cuerpo, que el
 * de columnas conserve el orden de su array, y lo que solo se puede probar ahora
 * que hay tres endpoints sobre la misma tabla: que ninguno se lleve la respuesta
 * de otro.
 */

function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

interface FilaIdempotencia {
  key: string;
  client_id: string;
  request_hash: string;
  status_code: number;
  response_body: unknown;
}

async function leerRegistros(client: Client): Promise<FilaIdempotencia[]> {
  const filas = await client.query<FilaIdempotencia>(
    `SELECT key, client_id, request_hash, status_code, response_body
       FROM idempotency_record
      ORDER BY key, client_id, request_hash`,
  );
  return filas.rows;
}

/** Las keys de las columnas del tablero, en orden de position. Por SQL. */
async function keysDeColumnas(client: Client, boardId: string): Promise<string[]> {
  const filas = await client.query<{ key: string }>(
    `SELECT key FROM board_column WHERE board_id = $1 ORDER BY position`,
    [boardId],
  );
  return filas.rows.map((fila) => fila.key);
}

function cabeceras(idempotencia?: string): Readonly<Record<string, string>> | undefined {
  return idempotencia === undefined ? undefined : { [CABECERA_CLAVE]: idempotencia };
}

let client: Client;
let taskman: CorePort;
let claveWrite: string;
let otraClaveWrite: string;
let tablero: BoardDetail;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveWrite = await emitirClave(client, ["WRITE"], { label: "primera" });
  otraClaveWrite = await emitirClave(client, ["WRITE"], { label: "segunda" });
  tablero = await sembrarTablero(taskman, { name: "Tablero" });
});

// --- POST /api/tasks ---------------------------------------------------------

describe("POST /api/tasks con Idempotency-Key (6.5)", () => {
  function postear(args: { cuerpo: unknown; clave: string; idempotencia?: string }): Request {
    const extra = cabeceras(args.idempotencia);
    return peticion({
      metodo: "POST",
      ruta: "/api/tasks",
      clave: args.clave,
      cuerpoCrudo: JSON.stringify(args.cuerpo),
      ...(extra === undefined ? {} : { cabeceras: extra }),
    });
  }

  function cuerpoDe(title: string): Record<string, unknown> {
    return { board_id: tablero.id, column_key: "TODO", title };
  }

  it("sin cabecera, dos peticiones iguales crean DOS tareas", async () => {
    const cuerpo = cuerpoDe("Repetida");

    const primera = await crearTarea(postear({ cuerpo, clave: claveWrite }));
    const segunda = await crearTarea(postear({ cuerpo, clave: claveWrite }));

    expect([primera.status, segunda.status]).toEqual([201, 201]);
    expect(primera.headers.get(CABECERA_REPLAY)).toBeNull();

    expect(await contarFilas(client, "task")).toBe(2);
    expect(await contarFilas(client, "idempotency_record")).toBe(0);
  });

  it("la primera vez ejecuta y deja la fila con su hash, su status y su cuerpo", async () => {
    const cuerpo = cuerpoDe("Con clave");

    const respuesta = await crearTarea(postear({ cuerpo, clave: claveWrite, idempotencia: "t-1" }));

    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get(CABECERA_REPLAY)).toBe("false");

    const tarea = JSON.parse(await respuesta.text()) as Tarea;

    expect(await contarFilas(client, "task")).toBe(1);

    const registros = await leerRegistros(client);
    expect(registros).toHaveLength(1);
    expect(registros[0]?.key).toBe("t-1");
    expect(registros[0]?.client_id).toBe(prefijoDe(claveWrite));
    expect(registros[0]?.request_hash).toBe(hashDePeticion("POST", "/api/tasks", cuerpo));
    expect(registros[0]?.status_code).toBe(201);
    expect(registros[0]?.response_body).toEqual(tarea);
  });

  it("la misma clave con el mismo cuerpo reproduce y no crea una segunda tarea", async () => {
    const cuerpo = cuerpoDe("Una sola");

    const primera = await crearTarea(postear({ cuerpo, clave: claveWrite, idempotencia: "t-1" }));
    const segunda = await crearTarea(postear({ cuerpo, clave: claveWrite, idempotencia: "t-1" }));

    expect([primera.status, segunda.status]).toEqual([201, 201]);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("true");

    // Identica byte a byte, con el id de la tarea adentro.
    expect(sha256(await segunda.text())).toBe(sha256(await primera.text()));

    expect(await contarFilas(client, "task")).toBe(1);
    // Ni se reordeno la columna ni se volvio a auditar: la segunda no ejecuto.
    // El tablero sembrado ya trae un registro CREATE, de ahi el 2 y no el 1.
    expect(await contarFilas(client, "audit_log")).toBe(2);
  });

  it("la misma clave con un cuerpo distinto es 422 y no crea nada", async () => {
    await crearTarea(postear({ cuerpo: cuerpoDe("Primera"), clave: claveWrite, idempotencia: "t-1" }));

    const respuesta = await crearTarea(
      postear({ cuerpo: cuerpoDe("Otra"), clave: claveWrite, idempotencia: "t-1" }),
    );

    expect(respuesta.status).toBe(422);
    expect((await leerError(respuesta)).error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await contarFilas(client, "task")).toBe(1);
  });

  it("la misma clave desde OTRA API key crea su propia tarea", async () => {
    const cuerpo = cuerpoDe("Compartida");

    const primera = await crearTarea(postear({ cuerpo, clave: claveWrite, idempotencia: "t-1" }));
    const segunda = await crearTarea(postear({ cuerpo, clave: otraClaveWrite, idempotencia: "t-1" }));

    expect([primera.status, segunda.status]).toEqual([201, 201]);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("false");

    const uno = JSON.parse(await primera.text()) as Tarea;
    const dos = JSON.parse(await segunda.text()) as Tarea;
    expect(uno.id).not.toBe(dos.id);

    expect(await contarFilas(client, "task")).toBe(2);

    const registros = await leerRegistros(client);
    expect(registros.map((fila) => fila.key)).toEqual(["t-1", "t-1"]);
    expect(new Set(registros.map((fila) => fila.client_id)).size).toBe(2);
  });
});

// --- POST /api/boards/{id}/columns -------------------------------------------

describe("POST /api/boards/{id}/columns con Idempotency-Key (6.5)", () => {
  function postear(args: {
    cuerpo: unknown;
    clave: string;
    idempotencia?: string;
    boardId?: string;
  }): Request {
    const extra = cabeceras(args.idempotencia);
    return peticion({
      metodo: "POST",
      ruta: `/api/boards/${args.boardId ?? tablero.id}/columns`,
      clave: args.clave,
      cuerpoCrudo: JSON.stringify(args.cuerpo),
      ...(extra === undefined ? {} : { cabeceras: extra }),
    });
  }

  function ruta(boardId?: string): { params: Promise<{ id: string }> } {
    return contextoDeRuta(boardId ?? tablero.id);
  }

  /**
   * La version de "dos peticiones iguales crean dos entidades" que este endpoint
   * admite.
   *
   * Con el MISMO cuerpo no puede haber dos columnas: la key es unica por tablero
   * (5.2) y la segunda se va en un DUPLICATE_KEY. Eso mismo es la prueba de que
   * sin cabecera no hay deduplicacion —la segunda peticion SE EJECUTO y choco
   * contra el dominio, en vez de recibir una copia de la primera— y el caso con
   * keys distintas muestra las dos entidades.
   */
  it("sin cabecera no hay deduplicacion: la repetida se ejecuta y choca con DUPLICATE_KEY", async () => {
    const cuerpo = { name: "Revision", key: "REVIEW" };

    const primera = await crearColumna(postear({ cuerpo, clave: claveWrite }), ruta());
    const segunda = await crearColumna(postear({ cuerpo, clave: claveWrite }), ruta());

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(409);
    expect((await leerError(segunda)).error.code).toBe("DUPLICATE_KEY");
    expect(await contarFilas(client, "idempotency_record")).toBe(0);

    // Y con keys distintas, las dos entidades.
    const tercera = await crearColumna(
      postear({ cuerpo: { name: "Bloqueada", key: "BLOCKED" }, clave: claveWrite }),
      ruta(),
    );

    expect(tercera.status).toBe(201);
    // Las cuatro por defecto de la 4.3 mas REVIEW mas BLOCKED.
    expect(await keysDeColumnas(client, tablero.id)).toHaveLength(6);
  });

  it("la primera vez ejecuta y deja la fila con su hash, su status y su cuerpo", async () => {
    const cuerpo = { name: "Revision", key: "REVIEW" };

    const respuesta = await crearColumna(
      postear({ cuerpo, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );

    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get(CABECERA_REPLAY)).toBe("false");

    const salida = JSON.parse(await respuesta.text()) as ColumnaConOrden;

    const registros = await leerRegistros(client);
    expect(registros).toHaveLength(1);
    expect(registros[0]?.request_hash).toBe(
      hashDePeticion("POST", `/api/boards/${tablero.id}/columns`, cuerpo),
    );
    expect(registros[0]?.status_code).toBe(201);
    // El cuerpo guardado son las DOS mitades, no solo la columna creada.
    expect(registros[0]?.response_body).toEqual(salida);
  });

  /**
   * Criterio 8: la reproduccion devuelve el `{ column, columns }` completo y
   * con el orden de `columns` intacto.
   *
   * La columna se inserta en position 0 a proposito, para que el orden guardado
   * NO sea el alfabetico ni el de creacion: si la forma canonica reordenara
   * arrays —o si JSONB los reordenara al guardarlos— esto lo veria.
   */
  it("reproduce el { column, columns } completo, con el orden de columns intacto", async () => {
    const cuerpo = { name: "Revision", key: "REVIEW", position: 0 };

    const primera = await crearColumna(
      postear({ cuerpo, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );
    const segunda = await crearColumna(
      postear({ cuerpo, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );

    expect([primera.status, segunda.status]).toEqual([201, 201]);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("true");

    const textoPrimera = await primera.text();
    const textoSegunda = await segunda.text();

    expect(sha256(textoSegunda)).toBe(sha256(textoPrimera));

    const reproducida = JSON.parse(textoSegunda) as ColumnaConOrden;
    const esperado = ["REVIEW", "BACKLOG", "TODO", "IN_PROGRESS", "DONE"];

    expect(reproducida.column.key).toBe("REVIEW");
    expect(reproducida.columns.map((c) => c.key)).toEqual(esperado);
    expect(reproducida.columns.map((c) => c.position)).toEqual([0, 1, 2, 3, 4]);

    // Y la base dice lo mismo: no se creo una segunda columna ni se reordeno
    // nada por la peticion reproducida.
    expect(await keysDeColumnas(client, tablero.id)).toEqual(esperado);
  });

  it("la misma clave con un cuerpo distinto es 422 y no crea nada", async () => {
    await crearColumna(
      postear({ cuerpo: { name: "Revision", key: "REVIEW" }, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );

    const respuesta = await crearColumna(
      postear({ cuerpo: { name: "Bloqueada", key: "BLOCKED" }, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );

    expect(respuesta.status).toBe(422);
    expect((await leerError(respuesta)).error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await keysDeColumnas(client, tablero.id)).toHaveLength(5);
  });

  it("la misma clave desde OTRA API key crea su propia columna", async () => {
    const primera = await crearColumna(
      postear({ cuerpo: { name: "Revision", key: "REVIEW" }, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );
    // Cuerpo distinto: dos columnas con la misma key en el mismo tablero no
    // pueden existir, asi que lo que se aisla es la CLAVE, no el cuerpo.
    const segunda = await crearColumna(
      postear({
        cuerpo: { name: "Bloqueada", key: "BLOCKED" },
        clave: otraClaveWrite,
        idempotencia: "c-1",
      }),
      ruta(),
    );

    expect([primera.status, segunda.status]).toEqual([201, 201]);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("false");

    const registros = await leerRegistros(client);
    expect(registros.map((fila) => fila.key)).toEqual(["c-1", "c-1"]);
    expect(new Set(registros.map((fila) => fila.client_id)).size).toBe(2);
    expect(await keysDeColumnas(client, tablero.id)).toHaveLength(6);
  });

  it("la misma clave y el mismo cuerpo sobre OTRO tablero es otra peticion", async () => {
    const otro = await sembrarTablero(taskman, { name: "Otro tablero" });
    const cuerpo = { name: "Revision", key: "REVIEW" };

    const primera = await crearColumna(
      postear({ cuerpo, clave: claveWrite, idempotencia: "c-1" }),
      ruta(),
    );
    const segunda = await crearColumna(
      postear({ cuerpo, clave: claveWrite, idempotencia: "c-1", boardId: otro.id }),
      ruta(otro.id),
    );

    // El `{id}` esta en la ruta y la ruta esta en el hash, asi que los hashes
    // difieren. Como la PK es (key, client_id), el registro que ya existe es el
    // mismo: no reproduce —que seria devolver la columna del OTRO tablero— sino
    // que rechaza.
    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(422);
    expect(await keysDeColumnas(client, otro.id)).toHaveLength(4);
  });
});

// --- La misma clave en endpoints distintos -----------------------------------

describe("la misma Idempotency-Key en endpoints distintos", () => {
  /**
   * EL CASO QUE DECIDE, y el que no se pudo probar hasta que hubo mas de un
   * endpoint: un cuerpo que es VALIDO en un endpoint y se reenvia tal cual a
   * otro con la misma clave.
   *
   * `{"name":"X"}` crea un tablero y no es un cuerpo valido de POST /api/tasks.
   * Da igual: la idempotencia se resuelve ANTES del esquema, asi que si los dos
   * hashearan igual, /api/tasks devolveria 201 con un TABLERO adentro. Lo que lo
   * impide es que el metodo y la ruta entren en el hash.
   */
  it("un cuerpo identico en dos endpoints NO reproduce la respuesta del otro", async () => {
    const cuerpo = '{"name":"Alfa"}';
    const clave = { [CABECERA_CLAVE]: "compartida" };

    const delTablero = await crearTablero(
      peticion({ metodo: "POST", ruta: "/api/boards", clave: claveWrite, cuerpoCrudo: cuerpo, cabeceras: clave }),
    );

    expect(delTablero.status).toBe(201);
    const creado = JSON.parse(await delTablero.text()) as TableroDetallado;
    expect(creado.name).toBe("Alfa");

    const deLaTarea = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveWrite, cuerpoCrudo: cuerpo, cabeceras: clave }),
    );

    // 422 y NO 201: los hashes difieren porque el metodo y la ruta entran, asi
    // que la clave se ve como reusada con otra peticion. Lo que NO puede pasar,
    // y es el bug que esto previene, es un 201 con el tablero adentro.
    expect(deLaTarea.status).toBe(422);
    expect((await leerError(deLaTarea)).error.code).toBe("IDEMPOTENCY_MISMATCH");

    expect(await contarFilas(client, "task")).toBe(0);
    // Un solo registro: la PK es (key, client_id) y el endpoint NO es columna.
    expect(await contarFilas(client, "idempotency_record")).toBe(1);
  });

  /**
   * "Cada uno hace lo suyo" SI ocurre cuando las peticiones vienen de clientes
   * distintos, que es lo unico que separa dos registros: la PK es
   * `(key, client_id)`.
   */
  it("desde clientes distintos, cada endpoint hace lo suyo con la misma clave", async () => {
    const clave = { [CABECERA_CLAVE]: "compartida" };

    const delTablero = await crearTablero(
      peticion({
        metodo: "POST",
        ruta: "/api/boards",
        clave: claveWrite,
        cuerpoCrudo: '{"name":"Alfa"}',
        cabeceras: clave,
      }),
    );

    const deLaTarea = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: otraClaveWrite,
        cuerpoCrudo: JSON.stringify({ board_id: tablero.id, column_key: "TODO", title: "Suya" }),
        cabeceras: clave,
      }),
    );

    const deLaColumna = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: await emitirClave(client, ["WRITE"], { label: "tercera" }),
        cuerpoCrudo: JSON.stringify({ name: "Revision", key: "REVIEW" }),
        cabeceras: clave,
      }),
      contextoDeRuta(tablero.id),
    );

    expect([delTablero.status, deLaTarea.status, deLaColumna.status]).toEqual([201, 201, 201]);

    // Ninguno reprodujo: los tres ejecutaron lo suyo.
    for (const respuesta of [delTablero, deLaTarea, deLaColumna]) {
      expect(respuesta.headers.get(CABECERA_REPLAY)).toBe("false");
    }

    // Y cada uno devolvio SU forma, no la del anterior.
    expect((JSON.parse(await delTablero.text()) as TableroDetallado).columns).toHaveLength(4);
    expect((JSON.parse(await deLaTarea.text()) as Tarea).title).toBe("Suya");
    expect((JSON.parse(await deLaColumna.text()) as ColumnaConOrden).column.key).toBe("REVIEW");

    const registros = await leerRegistros(client);
    expect(registros).toHaveLength(3);
    expect(new Set(registros.map((fila) => fila.key))).toEqual(new Set(["compartida"]));
    // Tres hashes distintos: el metodo y la ruta los separan aunque la clave sea
    // la misma.
    expect(new Set(registros.map((fila) => fila.request_hash)).size).toBe(3);
  });
});
