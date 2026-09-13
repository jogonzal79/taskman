import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as crearTablero } from "../app/api/boards/route.js";
import { POST as crearTarea } from "../app/api/tasks/route.js";
import { LIMITE_CUERPO_BYTES } from "../lib/http.js";
import {
  connectDb,
  contarFilas,
  emitirClave,
  leerError,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * El tope de 256 KB por cuerpo de peticion (7.3).
 *
 * Lo que hay que sostener no es solo "devuelve 413": es que el cuerpo NO SE LEA
 * entero. El limite de peticiones de la 7.3 acota el volumen DE peticiones y no
 * el volumen POR peticion, asi que sin esto una sola peticion de 50 MB se parsea
 * completa antes de que el esquema la rechace.
 *
 * Por eso las pruebas centrales miden con un cuerpo que CUENTA lo que se le
 * pidio: un stream que entrega trozos de a uno y anota cuantos entrego y si lo
 * cancelaron. Afirmar "no se parsea" sin medirlo seria afirmar justamente lo que
 * no se ve desde el resultado.
 */

const KB = 1024;

interface CuerpoMedido {
  readonly stream: ReadableStream<Uint8Array>;
  /** Bytes que el consumidor llego a pedir. */
  readonly entregados: () => number;
  readonly cancelado: () => boolean;
}

/**
 * Un cuerpo de `totalKb` KB en trozos de `trozoKb`, que anota lo que se le pide.
 *
 * El stream no produce nada hasta que alguien lee: asi `entregados()` es
 * exactamente cuanto del cuerpo llego a cruzar la frontera, no cuanto habia.
 */
function cuerpoQueCuenta(totalKb: number, trozoKb = 64): CuerpoMedido {
  const trozo = new Uint8Array(trozoKb * KB).fill(0x20); // espacios: JSON valido a medias
  let entregados = 0;
  let restantes = Math.ceil(totalKb / trozoKb);
  let cancelado = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controlador) {
      if (restantes === 0) {
        controlador.close();

        return;
      }

      restantes -= 1;
      entregados += trozo.byteLength;
      controlador.enqueue(trozo);
    },
    cancel() {
      cancelado = true;
    },
  });

  return { stream, entregados: () => entregados, cancelado: () => cancelado };
}

/** Un Request con cuerpo de stream: no lleva Content-Length, como un chunked. */
function peticionConStream(
  ruta: string,
  clave: string,
  cuerpo: ReadableStream<Uint8Array>,
  cabeceras: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`http://taskman.test${ruta}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clave}`,
      "content-type": "application/json",
      ...cabeceras,
    },
    body: cuerpo,
    // Node lo exige para un cuerpo de stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

let client: Client;
let taskman: CorePort;
let claveWrite: string;
let boardId: string;
let columnId: string;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveWrite = await emitirClave(client, ["WRITE"], { label: "clave del tope" });

  const tablero = await sembrarTablero(taskman, { name: "Tablero del tope" });
  boardId = tablero.id;
  columnId = tablero.columns[0]?.id ?? "";
});

describe("tope de 256 KB por cuerpo (7.3)", () => {
  it("el limite es el de la 7.3, en bytes", () => {
    expect(LIMITE_CUERPO_BYTES).toBe(256 * KB);
  });

  it("un cuerpo por debajo del tope funciona igual que antes", async () => {
    // Una descripcion de 200 KB: grande, valida, por debajo del tope.
    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: {
          board_id: boardId,
          column_id: columnId,
          title: "con una descripcion larga",
          description: "x".repeat(200 * KB),
        },
      }),
    );

    expect(respuesta.status).toBe(201);
    expect(await contarFilas(client, "task")).toBe(1);
  });

  it("por encima del tope devuelve 413 con la envoltura de la 6.4", async () => {
    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: { board_id: boardId, column_id: columnId, title: "x".repeat(300 * KB) },
      }),
    );

    expect(respuesta.status).toBe(413);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(cuerpo.error.request_id).toBe(respuesta.headers.get("X-Request-Id"));
    expect(cuerpo.error.details).toMatchObject({ limit_bytes: LIMITE_CUERPO_BYTES });
    expect(cuerpo.error.hint).toBeDefined();

    // Y no ejecuto nada.
    expect(await contarFilas(client, "task")).toBe(0);
  });

  it("MIDE que no se lee entero: de 50 MB cruzan poco mas de 256 KB y se cancela", async () => {
    const medido = cuerpoQueCuenta(50 * KB);

    const respuesta = await crearTarea(
      peticionConStream("/api/tasks", claveWrite, medido.stream),
    );

    expect(respuesta.status).toBe(413);

    /**
     * La garantia es que la memoria queda del ORDEN DEL TOPE y no del orden del
     * cuerpo. Medido: 384 KB de los 50 MB, o sea el tope mas dos trozos, porque el
     * runtime va un trozo por delante del lector —ese adelanto no lo controla este
     * codigo—. Por eso el margen es un multiplo del tope y no "el tope mas un
     * trozo", que es lo que escribi primero y la medicion desmintio.
     */
    expect(medido.entregados()).toBeLessThanOrEqual(LIMITE_CUERPO_BYTES * 2);
    // Y en proporcion: menos del 2% de lo que habia para leer.
    expect(medido.entregados()).toBeLessThan(50 * KB * KB * 0.02);
    // El stream se corto: el resto del cuerpo no se transfirio.
    expect(medido.cancelado()).toBe(true);
  });

  it("SIN Content-Length tambien se corta: el cuerpo de stream no lo lleva", async () => {
    const medido = cuerpoQueCuenta(50 * KB);
    const peticionDeStream = peticionConStream("/api/tasks", claveWrite, medido.stream);

    // La premisa de la prueba: si esta cabecera existiera, el atajo la habria
    // atajado y no estariamos midiendo el corte del stream.
    expect(peticionDeStream.headers.get("content-length")).toBeNull();

    const respuesta = await crearTarea(peticionDeStream);

    expect(respuesta.status).toBe(413);
    expect(medido.cancelado()).toBe(true);

    const cuerpo = await leerError(respuesta);

    // Sin cabecera no hay nada que declarar, asi que `details` no la inventa.
    expect(cuerpo.error.details).toEqual({ limit_bytes: LIMITE_CUERPO_BYTES });
  });

  it("con un Content-Length que MIENTE tampoco: manda 50 MB declarando 100 bytes", async () => {
    const medido = cuerpoQueCuenta(50 * KB);

    const respuesta = await crearTarea(
      peticionConStream("/api/tasks", claveWrite, medido.stream, { "content-length": "100" }),
    );

    // El atajo de la cabecera habria dejado pasar esto: 100 < 256 KB. Lo que corta
    // es el contador del bucle.
    expect(respuesta.status).toBe(413);
    expect(medido.cancelado()).toBe(true);
    expect(medido.entregados()).toBeLessThanOrEqual(LIMITE_CUERPO_BYTES * 2);
  });

  it("un Content-Length que declara MAS que el tope se rechaza sin recorrer el cuerpo", async () => {
    const medido = cuerpoQueCuenta(50 * KB);

    const respuesta = await crearTarea(
      peticionConStream("/api/tasks", claveWrite, medido.stream, {
        "content-length": String(300 * KB),
      }),
    );

    expect(respuesta.status).toBe(413);

    /**
     * El atajo rechaza sin recorrer el cuerpo, y "sin recorrer" no es "sin un
     * byte": medido, el runtime ya habia adelantado UN trozo antes de que el
     * handler corriera. Lo que este codigo garantiza es que no pide ninguno; el
     * adelanto no lo controla. La diferencia que importa es la misma de siempre:
     * un trozo contra 50 MB.
     */
    expect(medido.entregados()).toBeLessThanOrEqual(64 * KB);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.details).toMatchObject({ declared_bytes: 300 * KB });
  });

  it("el tope rige en TODOS los endpoints que leen cuerpo, no solo en uno", async () => {
    const medido = cuerpoQueCuenta(50 * KB);

    const respuesta = await crearTablero(
      peticionConStream("/api/boards", claveWrite, medido.stream),
    );

    expect(respuesta.status).toBe(413);
    expect(await contarFilas(client, "board")).toBe(1); // el sembrado, nada mas
  });

  it("un cuerpo que no es JSON sigue siendo 400 y no 413", async () => {
    const respuesta = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveWrite, cuerpoCrudo: "{no json" }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });
});
