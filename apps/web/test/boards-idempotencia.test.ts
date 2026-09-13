import { createHash } from "node:crypto";

import type { TableroDetallado } from "@taskman/contracts";
import { prefijoDe } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as crear } from "../app/api/boards/route.js";
import {
  CABECERA_CLAVE,
  CABECERA_REPLAY,
  canonicalizar,
  hashDePeticion,
  LIMITE_CLAVE_IDEMPOTENCIA,
} from "../lib/idempotencia.js";
import {
  connectDb,
  contarFilas,
  emitirClave,
  leerError,
  peticion,
  truncateAll,
} from "./helpers.js";

/**
 * Idempotencia de POST /api/boards (6.5), nivel "Contrato REST" de la 10.
 *
 * Los tres caminos de la 6.5 —sin registro previo, mismo hash, hash distinto—
 * mas los dos que la especificacion no nombra y el mecanismo necesita igual: el
 * aislamiento por cliente, que es el desvio declarado de la 4.1, y la carrera de
 * dos peticiones simultaneas con la misma clave.
 *
 * Casi todas las aserciones de "no se creo un segundo tablero" van por SQL y no
 * por la API: lo que hay que probar es que la operacion NO ocurrio, y preguntarle
 * eso al mismo endpoint que la habria hecho es preguntarle al acusado.
 */

const RUTA = "/api/boards";

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
      ORDER BY key, client_id`,
  );
  return filas.rows;
}

async function nombresDeTableros(client: Client): Promise<string[]> {
  const filas = await client.query<{ name: string }>(`SELECT name FROM board ORDER BY name`);
  return filas.rows.map((fila) => fila.name);
}

/** POST /api/boards con cuerpo escrito a mano, para controlar el orden exacto. */
function postear(args: { cuerpo: string; clave: string; idempotencia?: string }): Request {
  return peticion({
    metodo: "POST",
    ruta: RUTA,
    clave: args.clave,
    cuerpoCrudo: args.cuerpo,
    ...(args.idempotencia === undefined
      ? {}
      : { cabeceras: { [CABECERA_CLAVE]: args.idempotencia } }),
  });
}

let client: Client;
let claveWrite: string;
let otraClaveWrite: string;

beforeAll(async () => {
  client = await connectDb();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveWrite = await emitirClave(client, ["WRITE"], { label: "primera" });
  otraClaveWrite = await emitirClave(client, ["WRITE"], { label: "segunda" });
});

describe("canonicalizacion del cuerpo (6.5)", () => {
  it("el ORDEN de las claves no cambia el hash, y recursivamente", () => {
    const a = hashDePeticion("POST", RUTA, { name: "Alfa", meta: { x: 1, y: 2 } });
    const b = hashDePeticion("POST", RUTA, { meta: { y: 2, x: 1 }, name: "Alfa" });

    expect(a).toBe(b);
  });

  it("el orden de un ARRAY si cambia el hash", () => {
    const a = hashDePeticion("POST", RUTA, { columns: ["TODO", "DONE"] });
    const b = hashDePeticion("POST", RUTA, { columns: ["DONE", "TODO"] });

    expect(a).not.toBe(b);
  });

  it("el unicode NO se normaliza: precompuesta y descompuesta son distintas", () => {
    // "revisión" con U+00F3 contra la misma palabra con o + U+0301. Son iguales
    // en pantalla y distintas como dato, y la 6.5 pregunta si la peticion es LA
    // MISMA, no si se parece.
    const precompuesta = "revisión";
    const descompuesta = "revisión";

    expect(precompuesta.normalize("NFC")).toBe(descompuesta.normalize("NFC"));
    expect(hashDePeticion("POST", RUTA, { name: precompuesta })).not.toBe(
      hashDePeticion("POST", RUTA, { name: descompuesta }),
    );
  });

  it("el metodo y la ruta entran en el hash", () => {
    const cuerpo = { name: "Alfa" };

    expect(hashDePeticion("POST", RUTA, cuerpo)).not.toBe(
      hashDePeticion("PATCH", RUTA, cuerpo),
    );
    expect(hashDePeticion("POST", RUTA, cuerpo)).not.toBe(
      hashDePeticion("POST", "/api/tasks", cuerpo),
    );
  });

  it("es un SHA-256 en hexadecimal minusculo, que es lo que la base acepta", () => {
    expect(hashDePeticion("POST", RUTA, { name: "Alfa" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalizar ordena las claves y respeta los arrays", () => {
    expect(canonicalizar({ b: 1, a: [3, 2], c: { z: null, y: "x" } })).toBe(
      '{"a":[3,2],"b":1,"c":{"y":"x","z":null}}',
    );
  });
});

describe("POST /api/boards sin Idempotency-Key", () => {
  it("dos peticiones iguales crean DOS tableros y no escriben ningun registro", async () => {
    const cuerpo = '{"name":"Alfa"}';

    const primera = await crear(postear({ cuerpo, clave: claveWrite }));
    const segunda = await crear(postear({ cuerpo, clave: claveWrite }));

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    // La cabecera no aparece: quien no pidio la garantia no recibe una respuesta
    // que hable de ella.
    expect(primera.headers.get(CABECERA_REPLAY)).toBeNull();
    expect(segunda.headers.get(CABECERA_REPLAY)).toBeNull();

    const uno = (await primera.json()) as TableroDetallado;
    const dos = (await segunda.json()) as TableroDetallado;
    expect(uno.id).not.toBe(dos.id);

    expect(await contarFilas(client, "board")).toBe(2);
    expect(await contarFilas(client, "idempotency_record")).toBe(0);
  });
});

describe("POST /api/boards con Idempotency-Key", () => {
  it("la primera vez ejecuta y deja la fila con su hash, su status y su cuerpo", async () => {
    const cuerpo = '{"name":"Alfa","description":"la primera"}';

    const respuesta = await crear(postear({ cuerpo, clave: claveWrite, idempotencia: "k-1" }));

    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get(CABECERA_REPLAY)).toBe("false");

    const texto = await respuesta.text();
    const tablero = JSON.parse(texto) as TableroDetallado;

    expect(await contarFilas(client, "board")).toBe(1);

    const registros = await leerRegistros(client);
    expect(registros).toHaveLength(1);

    const fila = registros[0];
    expect(fila?.key).toBe("k-1");
    expect(fila?.client_id).toBe(prefijoDe(claveWrite));
    expect(fila?.request_hash).toBe(hashDePeticion("POST", RUTA, JSON.parse(cuerpo)));
    expect(fila?.status_code).toBe(201);
    // El cuerpo guardado es EL que se devolvio, con el id del tablero incluido.
    expect(fila?.response_body).toEqual(tablero);
  });

  it("repetir la misma clave con el mismo cuerpo reproduce y no crea un segundo tablero", async () => {
    const cuerpo = '{"name":"Alfa","description":"la primera"}';

    const primera = await crear(postear({ cuerpo, clave: claveWrite, idempotencia: "k-1" }));
    const segunda = await crear(postear({ cuerpo, clave: claveWrite, idempotencia: "k-1" }));

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("true");

    const textoPrimera = await primera.text();
    const textoSegunda = await segunda.text();

    // Criterio 4: identica byte a byte, no "parecida". El id del tablero va
    // adentro, asi que esto tambien prueba que no se genero uno nuevo.
    expect(sha256(textoSegunda)).toBe(sha256(textoPrimera));

    // Y por SQL, que es la pregunta que no se le hace al endpoint acusado.
    expect(await contarFilas(client, "board")).toBe(1);
    expect(await contarFilas(client, "idempotency_record")).toBe(1);
    // Tampoco se audito dos veces: la segunda no ejecuto nada.
    expect(await contarFilas(client, "audit_log")).toBe(1);

    // El X-Request-Id SI cambia, y tiene que cambiar: es el de esta peticion.
    expect(segunda.headers.get("X-Request-Id")).not.toBe(primera.headers.get("X-Request-Id"));
    expect(segunda.headers.get("Cache-Control")).toBe("no-store");
  });

  it("las claves del cuerpo en otro ORDEN son la misma peticion: reproduce", async () => {
    const primera = await crear(
      postear({ cuerpo: '{"name":"Alfa","description":"d"}', clave: claveWrite, idempotencia: "k-1" }),
    );
    const segunda = await crear(
      postear({ cuerpo: '{"description":"d","name":"Alfa"}', clave: claveWrite, idempotencia: "k-1" }),
    );

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("true");
    expect(sha256(await segunda.text())).toBe(sha256(await primera.text()));
    expect(await contarFilas(client, "board")).toBe(1);
  });

  it("la misma clave con un cuerpo distinto es 422 IDEMPOTENCY_MISMATCH y no crea nada", async () => {
    await crear(postear({ cuerpo: '{"name":"Alfa"}', clave: claveWrite, idempotencia: "k-1" }));

    const respuesta = await crear(
      postear({ cuerpo: '{"name":"Beta"}', clave: claveWrite, idempotencia: "k-1" }),
    );

    expect(respuesta.status).toBe(422);

    const error = await leerError(respuesta);
    expect(error.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(error.error.details?.["idempotency_key"]).toBe("k-1");
    expect(error.error.hint).toBeDefined();

    // Ni el tablero nuevo, ni una segunda fila, ni un segundo registro de
    // auditoria: la operacion no llego a ejecutarse.
    expect(await nombresDeTableros(client)).toEqual(["Alfa"]);
    expect(await contarFilas(client, "idempotency_record")).toBe(1);
    expect(await contarFilas(client, "audit_log")).toBe(1);
  });

  /**
   * El caso del ARRAY en otro orden, de punta a punta.
   *
   * La fila se SIEMBRA por SQL, y es la unica de esta suite que lo hace, porque
   * hoy ningun cuerpo valido de POST /api/boards contiene un array: `crearTablero`
   * es un `strictObject` de `name` y `description`, asi que una peticion con
   * `columns` se va en un 400 antes de guardar nada. La fila sembrada es
   * exactamente la que dejaria esa peticion si el contrato aceptara el campo —el
   * mismo hash que calcula `hashDePeticion`— y lo que se ejercita es lo que
   * importa: la COMPARACION del adaptador.
   */
  describe("con un array en el cuerpo (fila sembrada)", () => {
    const GUARDADO = { name: "Alfa", columns: ["TODO", "DONE"] };
    const REORDENADO = { name: "Alfa", columns: ["DONE", "TODO"] };
    const CUERPO_GUARDADO = { id: "sembrado", name: "Alfa" };

    beforeEach(async () => {
      await client.query(
        `INSERT INTO idempotency_record (key, client_id, request_hash, status_code, response_body)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "k-array",
          prefijoDe(claveWrite),
          hashDePeticion("POST", RUTA, GUARDADO),
          201,
          JSON.stringify(CUERPO_GUARDADO),
        ],
      );
    });

    it("el MISMO array reproduce", async () => {
      const respuesta = await crear(
        postear({
          cuerpo: JSON.stringify(GUARDADO),
          clave: claveWrite,
          idempotencia: "k-array",
        }),
      );

      expect(respuesta.status).toBe(201);
      expect(respuesta.headers.get(CABECERA_REPLAY)).toBe("true");
      expect(await respuesta.text()).toBe(canonicalizar(CUERPO_GUARDADO));
      expect(await contarFilas(client, "board")).toBe(0);
    });

    it("el array REORDENADO es otra peticion: 422", async () => {
      const respuesta = await crear(
        postear({
          cuerpo: JSON.stringify(REORDENADO),
          clave: claveWrite,
          idempotencia: "k-array",
        }),
      );

      expect(respuesta.status).toBe(422);
      expect((await leerError(respuesta)).error.code).toBe("IDEMPOTENCY_MISMATCH");
      expect(await contarFilas(client, "board")).toBe(0);
    });
  });

  it("la misma clave desde OTRA API key es otro cliente: crea su propio tablero", async () => {
    const cuerpo = '{"name":"Alfa"}';

    const primera = await crear(postear({ cuerpo, clave: claveWrite, idempotencia: "k-1" }));
    const segunda = await crear(postear({ cuerpo, clave: otraClaveWrite, idempotencia: "k-1" }));

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    // La segunda EJECUTA: no reprodujo nada de la primera.
    expect(segunda.headers.get(CABECERA_REPLAY)).toBe("false");

    const uno = (await primera.json()) as TableroDetallado;
    const dos = (await segunda.json()) as TableroDetallado;
    expect(uno.id).not.toBe(dos.id);

    expect(await contarFilas(client, "board")).toBe(2);

    // Dos filas con la MISMA key y distinto client_id: es lo que permite la PK
    // compuesta, y el motivo por el que se desvio de la 4.1.
    const registros = await leerRegistros(client);
    expect(registros.map((fila) => fila.key)).toEqual(["k-1", "k-1"]);
    expect(new Set(registros.map((fila) => fila.client_id)).size).toBe(2);
  });

  it("rechaza una clave vacia y una mas larga que el VARCHAR(128)", async () => {
    const vacia = await crear(
      postear({ cuerpo: '{"name":"Alfa"}', clave: claveWrite, idempotencia: "" }),
    );

    expect(vacia.status).toBe(400);
    expect((await leerError(vacia)).error.code).toBe("VALIDATION_ERROR");

    const larga = await crear(
      postear({
        cuerpo: '{"name":"Beta"}',
        clave: claveWrite,
        idempotencia: "k".repeat(LIMITE_CLAVE_IDEMPOTENCIA + 1),
      }),
    );

    expect(larga.status).toBe(400);
    expect((await leerError(larga)).error.code).toBe("VALIDATION_ERROR");

    // Un 22001 del driver por la misma cabecera seria un 500, y ademas habria
    // creado el tablero antes de fallar.
    expect(await contarFilas(client, "board")).toBe(0);
  });

  /**
   * La carrera: dos peticiones identicas a la vez.
   *
   * El resultado es el mismo por los dos caminos posibles —que la segunda vea la
   * fila de la primera y reproduzca, o que las dos ejecuten y la perdedora viole
   * la PK y reproduzca despues—, y el test afirma el INVARIANTE y no cual de los
   * dos ocurrio: cual sea depende de como interleaven dos transacciones y
   * fijarlo convertiria la prueba en una medicion del planificador.
   *
   * Varias rondas porque una sola difcilmente alcance a cruzar las dos
   * transacciones; con distinta clave cada una, que es lo que las hace
   * independientes entre si.
   */
  it("dos peticiones simultaneas con la misma clave crean UN solo tablero", async () => {
    const RONDAS = 8;

    for (let ronda = 0; ronda < RONDAS; ronda += 1) {
      const cuerpo = JSON.stringify({ name: `Concurrente ${ronda}` });
      const armar = (): Request =>
        postear({ cuerpo, clave: claveWrite, idempotencia: `k-${ronda}` });

      const [a, b] = await Promise.all([crear(armar()), crear(armar())]);

      expect([a?.status, b?.status]).toEqual([201, 201]);

      const textos = await Promise.all([a!.text(), b!.text()]);
      expect(sha256(textos[1]!)).toBe(sha256(textos[0]!));

      // Exactamente una de las dos ejecuto y la otra reprodujo.
      const reproducidas = [a!, b!].filter(
        (respuesta) => respuesta.headers.get(CABECERA_REPLAY) === "true",
      );
      expect(reproducidas).toHaveLength(1);
    }

    expect(await contarFilas(client, "board")).toBe(RONDAS);
    expect(await contarFilas(client, "idempotency_record")).toBe(RONDAS);
    expect(await contarFilas(client, "audit_log")).toBe(RONDAS);
  });
});
