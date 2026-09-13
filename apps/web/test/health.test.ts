import { salud, saludDegradada } from "@taskman/contracts";
import type { CamposDeLog } from "@taskman/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fijarLogger } from "../lib/log";
import { leerError, leerJson } from "./helpers";

/**
 * Contrato REST de GET /api/health (6.2, 11.1).
 *
 * Este endpoint era el unico de la 6.2 sin prueba de contrato, y las otras tres
 * excepciones que arrastraba venian de ahi: no validaba su salida porque su
 * cuerpo era una interfaz dentro del handler, no aparecia con `content` en
 * openapi.json por lo mismo, y no emitia el X-Request-Id que la 6.1 pide en TODA
 * respuesta. Lo que se prueba aca es justamente lo que no se probaba.
 *
 * COMO SE SIMULA LA BASE CAIDA: mockeando `comprobarConexion` del nucleo, no
 * tumbando el contenedor. Tumbarlo dejaria sin base a los otros doce archivos de
 * la suite —corren en el mismo proceso de vitest, de a uno pero contra la misma
 * instancia— y el 503 no es un estado de la base sino la traduccion que hace el
 * adaptador de que la sonda falle, que es lo que le toca probar a esta suite. El
 * mock es PARCIAL y envuelve a la funcion real, asi que el caso del 200 ejercita
 * la sonda de verdad contra PostgreSQL: `comprobarConexion` tampoco tenia prueba,
 * y por este camino queda ejercitada en el nivel donde se usa. Su plazo y su
 * propagacion de errores se prueban aparte, en `packages/core/test/health.test.ts`.
 */

/**
 * La version se lee del package.json de apps/web (`lib/version.ts`). El mock
 * existe SOLO para el caso del 500: es la unica forma de que el handler construya
 * un cuerpo que no cumpla su propio esquema sin romper el handler a proposito.
 * Con `versionFalsa` en undefined devuelve la real, asi que los demas casos
 * ejercitan el valor de verdad.
 */
let versionFalsa: string | undefined;

vi.mock("../lib/version", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/version")>();

  return {
    get VERSION(): string {
      return versionFalsa ?? real.VERSION;
    },
  };
});

vi.mock("@taskman/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@taskman/core")>();

  return { ...real, comprobarConexion: vi.fn(real.comprobarConexion) };
});

const { comprobarConexion } = await import("@taskman/core");
const { GET } = await import("../app/api/health/route");
const { VERSION } = await import("../lib/version");

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

/**
 * El handler registra el detalle del fallo en el log de la 11.1, no en la
 * respuesta. Capturarlo sirve para las dos cosas: afirmar que lo registro y que
 * el `request_id` de la linea es el de la cabecera.
 */
let lineas: Array<{ campos: CamposDeLog; mensaje: string }>;

beforeEach(() => {
  versionFalsa = undefined;
  vi.mocked(comprobarConexion).mockClear();

  lineas = [];
  const anotar = (campos: CamposDeLog, mensaje: string): void => {
    lineas.push({ campos, mensaje });
  };
  fijarLogger({ debug: anotar, info: anotar, warn: anotar, error: anotar });
});

afterEach(() => {
  // El setup de la suite vuelve a poner LOGGER_NULO antes de la siguiente.
  fijarLogger(undefined);
});

function porMensaje(mensaje: string): Array<{ campos: CamposDeLog; mensaje: string }> {
  return lineas.filter((linea) => linea.mensaje === mensaje);
}

describe("GET /api/health", () => {
  it("con la base arriba devuelve 200, X-Request-Id y un cuerpo que cumple el esquema", async () => {
    const respuesta = await GET();

    expect(respuesta.status).toBe(200);

    // 6.1: TODA respuesta lleva X-Request-Id, y este endpoint era la excepcion.
    expect(respuesta.headers.get("X-Request-Id")).toMatch(REQUEST_ID);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    // El cuerpo se valida con el MISMO esquema que publica openapi.json, no con
    // aserciones campo por campo: si el esquema cambia, esta prueba lo sigue.
    const cuerpo = salud.parse(await leerJson(respuesta));

    expect(cuerpo.status).toBe("ok");
    expect(cuerpo.version).toBe(VERSION);
    expect(cuerpo.database.ok).toBe(true);
    expect(Number.isInteger(cuerpo.database.latency_ms)).toBe(true);
    expect(cuerpo.database.latency_ms).toBeGreaterThanOrEqual(0);

    // La sonda real corrio: es la unica prueba que ejercita `comprobarConexion`
    // contra la base.
    expect(comprobarConexion).toHaveBeenCalledTimes(1);
    expect(porMensaje("la sonda a la base fallo")).toHaveLength(0);

    // Y dejo su linea por peticion (11.1), como todo endpoint.
    expect(porMensaje("peticion")).toHaveLength(1);
  });

  it("no exige clave: sin Authorization responde 200 y no 401", async () => {
    // El handler no recibe el Request, y eso es mas fuerte que no leer la
    // cabecera: no tiene de donde leerla. La 6.2 lo declara como el unico sin
    // autenticacion, y openapi.json lo publica con `security: []`.
    expect(GET.length).toBe(0);

    const respuesta = await GET();

    expect(respuesta.status).toBe(200);
  });

  it("con la sonda caida devuelve 503 degraded sin filtrar la cadena de conexion ni la traza", async () => {
    // Un error como el que da el driver de verdad: con host, puerto, base y
    // usuario dentro del mensaje, que es lo que no puede salir en el cuerpo.
    const fallo = new Error(
      "Can't reach database server at postgresql://taskman:taskman@127.0.0.1:5432/taskman",
    );

    vi.mocked(comprobarConexion).mockRejectedValueOnce(fallo);

    const respuesta = await GET();

    expect(respuesta.status).toBe(503);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(REQUEST_ID);

    const texto = await respuesta.clone().text();
    const cuerpo = saludDegradada.parse(await leerJson(respuesta));

    expect(cuerpo.status).toBe("degraded");
    expect(cuerpo.database.ok).toBe(false);
    expect(cuerpo.version).toBe(VERSION);

    // Nada del fallo sale al cuerpo: ni la cadena, ni el mensaje, ni la traza.
    // Se comprueba sobre el TEXTO y no sobre el objeto, porque lo que viaja es
    // el texto.
    for (const filtrado of ["postgresql", "127.0.0.1", "taskman:taskman", "5432", "Error", "at "]) {
      expect(texto).not.toContain(filtrado);
    }

    // Y el esquema es estricto, asi que el cuerpo tiene exactamente tres claves.
    expect(Object.keys(cuerpo).sort()).toEqual(["database", "status", "version"]);

    // El detalle SI va al log, con el request_id para poder correlacionarlo.
    const registradas = porMensaje("la sonda a la base fallo");

    expect(registradas).toHaveLength(1);
    expect(registradas[0]?.campos["request_id"]).toBe(respuesta.headers.get("X-Request-Id"));
    expect((registradas[0]?.campos["err"] as Record<string, unknown>)["message"]).toBe(
      fallo.message,
    );
  });

  it("un cuerpo que no cumple el esquema sale como 500, no como 200 ni como 503", async () => {
    // `version` vacia no supera el `min(1)` del esquema. Es el equivalente a un
    // campo mal formado por un bug nuestro.
    versionFalsa = "";

    const respuesta = await GET();

    expect(respuesta.status).toBe(500);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(REQUEST_ID);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("INTERNAL_ERROR");
    expect(cuerpo.error.request_id).toBe(respuesta.headers.get("X-Request-Id"));

    // Que NO sea 503 es la mitad del caso: el corte del try/catch del handler
    // existe para que un fallo de contrato no se disfrace de base caida.
    expect(cuerpo.error.message).not.toContain("base");
  });
});
