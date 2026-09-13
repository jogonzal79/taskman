import type { CamposDeLog, CorePort, Logger } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listarTableros, POST as crearTablero } from "../app/api/boards/route";
import { GET as sonda } from "../app/api/health/route";
import { GET as listarTareas } from "../app/api/tasks/route";
import { crearLogger, fijarLogger } from "../lib/log";
import {
  connectDb,
  emitirClave,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * El log estructurado por peticion de la 11.1.
 *
 * DOS NIVELES, y los dos hacen falta:
 *
 *   - Contra `crearLogger`, con un destino en memoria, se ejercita PINO DE VERDAD:
 *     que la linea sea JSON y que el nivel filtre. El resto de la suite corre con
 *     `LOGGER_NULO` (ver test/setup.ts), asi que si no fuera por estos casos el
 *     formato —lo unico que la 11.1 fija sobre el transporte— no se probaria nunca.
 *   - Contra los Route Handlers reales, con un logger que captura, se ejercita lo
 *     que la 11.1 pide de cada peticion: una linea, sus siete piezas, y que el
 *     request_id coincida con el X-Request-Id de la respuesta, que es lo que hace
 *     util todo esto.
 */

/** Un destino de pino: cualquier cosa con `write`. */
function destinoEnMemoria(): { lineas: string[]; write(linea: string): void } {
  const lineas: string[] = [];

  return {
    lineas,
    write(linea: string): void {
      lineas.push(linea);
    },
  };
}

interface LineaCapturada {
  readonly nivel: "debug" | "info" | "warn" | "error";
  readonly campos: CamposDeLog;
  readonly mensaje: string;
}

/** Un `Logger` que guarda lo que recibe, sin serializar. */
function loggerQueCaptura(): { lineas: LineaCapturada[]; logger: Logger } {
  const lineas: LineaCapturada[] = [];
  const anotar =
    (nivel: LineaCapturada["nivel"]) =>
    (campos: CamposDeLog, mensaje: string): void => {
      lineas.push({ nivel, campos, mensaje });
    };

  return {
    lineas,
    logger: {
      debug: anotar("debug"),
      info: anotar("info"),
      warn: anotar("warn"),
      error: anotar("error"),
    },
  };
}

describe("crearLogger (pino de verdad)", () => {
  it("escribe una linea JSON por llamada, con los campos y el mensaje", () => {
    const destino = destinoEnMemoria();

    crearLogger("info", destino).info({ request_id: "req_1", status: 200 }, "peticion");

    expect(destino.lineas).toHaveLength(1);

    const linea = JSON.parse(destino.lineas[0] ?? "") as Record<string, unknown>;

    expect(linea["request_id"]).toBe("req_1");
    expect(linea["status"]).toBe(200);
    expect(linea["msg"]).toBe("peticion");
    // 30 es `info` en pino. El nivel viaja en la linea, que es lo que permite
    // filtrar despues.
    expect(linea["level"]).toBe(30);
    expect(typeof linea["time"]).toBe("number");
  });

  it("respeta LOG_LEVEL: con `error` no escribe las lineas de info", () => {
    const destino = destinoEnMemoria();
    const logger = crearLogger("error", destino);

    logger.info({ a: 1 }, "no deberia salir");
    logger.debug({ a: 2 }, "tampoco");
    logger.error({ a: 3 }, "esta si");

    expect(destino.lineas).toHaveLength(1);
    expect(JSON.parse(destino.lineas[0] ?? "")["msg"]).toBe("esta si");
  });
});

describe("linea por peticion (11.1)", () => {
  let client: Client;
  let taskman: CorePort;
  let capturadas: LineaCapturada[];
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

    const captura = loggerQueCaptura();
    capturadas = captura.lineas;
    fijarLogger(captura.logger);

    claveRead = await emitirClave(client, ["READ"], { label: "clave de lectura" });
    claveWrite = await emitirClave(client, ["WRITE"], { label: "clave de escritura" });
  });

  afterEach(() => {
    // El setup de la suite vuelve a poner LOGGER_NULO antes de la siguiente.
    fijarLogger(undefined);
  });

  /** La linea de la peticion: la unica con `msg: "peticion"`. */
  function laPeticion(): LineaCapturada {
    const lineas = capturadas.filter((linea) => linea.mensaje === "peticion");

    expect(lineas).toHaveLength(1);

    return lineas[0] as LineaCapturada;
  }

  it("una peticion autenticada exitosa deja UNA linea con las siete piezas", async () => {
    await sembrarTablero(taskman, { name: "Tablero del log" });

    const respuesta = await listarTableros(
      peticion({ ruta: "/api/boards?limit=2", clave: claveRead }),
    );

    expect(respuesta.status).toBe(200);

    const linea = laPeticion();

    expect(linea.nivel).toBe("info");
    expect(linea.campos).toEqual({
      request_id: respuesta.headers.get("X-Request-Id"),
      method: "GET",
      route: "/api/boards",
      status: 200,
      duration_ms: expect.any(Number),
      client_id: claveRead.slice(0, "tmk_live_".length + 6),
      actor_type: "API",
    });

    // Las siete piezas de la 11.1, ni una mas ni una menos.
    expect(Object.keys(linea.campos).sort()).toEqual([
      "actor_type",
      "client_id",
      "duration_ms",
      "method",
      "request_id",
      "route",
      "status",
    ]);

    // La ruta va SIN query: `?limit=2` no aparece.
    expect(linea.campos["route"]).toBe("/api/boards");
    expect(linea.campos["duration_ms"]).toBeGreaterThanOrEqual(0);
  });

  it("un 401 deja linea, con lo que se sepa: sin clave que identificar", async () => {
    const respuesta = await listarTableros(peticion({ ruta: "/api/boards" }));

    expect(respuesta.status).toBe(401);

    const linea = laPeticion();

    expect(linea.nivel).toBe("info");
    expect(linea.campos).toMatchObject({
      request_id: respuesta.headers.get("X-Request-Id"),
      method: "GET",
      route: "/api/boards",
      status: 401,
      client_id: null,
      actor_type: "API",
    });
  });

  it("un 403 deja linea, y ahi SI hay prefijo", async () => {
    // Clave de lectura contra un endpoint de escritura.
    const respuesta = await crearTablero(
      peticion({ metodo: "POST", ruta: "/api/boards", clave: claveRead, cuerpo: { name: "No" } }),
    );

    expect(respuesta.status).toBe(403);

    const linea = laPeticion();

    expect(linea.campos).toMatchObject({
      request_id: respuesta.headers.get("X-Request-Id"),
      method: "POST",
      route: "/api/boards",
      status: 403,
      client_id: claveRead.slice(0, "tmk_live_".length + 6),
      actor_type: "API",
    });
  });

  it("/api/health tambien deja linea, aunque no pase por conAuth", async () => {
    const respuesta = await sonda();

    expect(respuesta.status).toBe(200);

    const linea = laPeticion();

    expect(linea.campos).toMatchObject({
      request_id: respuesta.headers.get("X-Request-Id"),
      method: "GET",
      route: "/api/health",
      status: 200,
      client_id: null,
      actor_type: "API",
    });
  });

  it("un 500 registra la traza completa y la respuesta no lleva nada del interior", async () => {
    // Una peticion cuyo handler revienta antes de responder: sin API_KEY_PEPPER,
    // `crearServicio` lanza dentro de `conAuth`. Es un fallo de configuracion del
    // servidor, o sea el 500 de la 6.4 por el camino real y no un mock.
    const pepper = process.env["API_KEY_PEPPER"];
    delete process.env["API_KEY_PEPPER"];

    let respuesta: Response;

    try {
      respuesta = await listarTareas(peticion({ ruta: "/api/tasks", clave: claveWrite }));
    } finally {
      process.env["API_KEY_PEPPER"] = pepper;
    }

    expect(respuesta.status).toBe(500);

    // MITAD UNO: el log lleva la traza completa.
    const fallo = capturadas.find((linea) => linea.mensaje === "fallo no controlado");

    expect(fallo).toBeDefined();
    expect(fallo?.nivel).toBe("error");
    expect(fallo?.campos["request_id"]).toBe(respuesta.headers.get("X-Request-Id"));

    const err = fallo?.campos["err"] as Record<string, unknown>;

    expect(err["type"]).toBe("Error");
    expect(err["message"]).toContain("API_KEY_PEPPER");
    expect(String(err["stack"])).toContain("at ");

    // La linea de la peticion sube a error, porque un 5xx no es una peticion mal
    // hecha sino un fallo nuestro.
    expect(laPeticion().nivel).toBe("error");
    expect(laPeticion().campos["status"]).toBe(500);

    // MITAD DOS: la respuesta solo lleva el codigo y el request_id.
    const cuerpo = (await respuesta.json()) as { error: Record<string, unknown> };

    expect(cuerpo.error["code"]).toBe("INTERNAL_ERROR");
    expect(cuerpo.error["request_id"]).toBe(respuesta.headers.get("X-Request-Id"));
    expect(Object.keys(cuerpo.error).sort()).toEqual(["code", "message", "request_id"]);

    const texto = JSON.stringify(cuerpo);

    expect(texto).not.toContain("API_KEY_PEPPER");
    expect(texto).not.toContain("at ");
    expect(texto).not.toContain("stack");
  });

  it("NINGUNA linea contiene la clave completa, con trafico real de las dos claves", async () => {
    await sembrarTablero(taskman, { name: "Tablero" });

    await listarTableros(peticion({ ruta: "/api/boards", clave: claveRead }));
    await listarTableros(peticion({ ruta: "/api/boards", clave: claveWrite }));
    await crearTablero(
      peticion({ metodo: "POST", ruta: "/api/boards", clave: claveWrite, cuerpo: { name: "Otro" } }),
    );
    await crearTablero(
      peticion({ metodo: "POST", ruta: "/api/boards", clave: claveRead, cuerpo: { name: "No" } }),
    );
    await listarTableros(peticion({ ruta: "/api/boards", clave: "tmk_live_inventada" }));
    await sonda();

    // Se busca sobre el TEXTO de todo lo registrado, que es lo que terminaria en
    // el archivo de log, y no campo por campo.
    const todo = JSON.stringify(capturadas);

    expect(capturadas.filter((linea) => linea.mensaje === "peticion")).toHaveLength(6);

    for (const clave of [claveRead, claveWrite]) {
      expect(todo).not.toContain(clave);

      // El prefijo publico SI aparece, que es lo que la 11.1 pide; lo que no puede
      // aparecer es un caracter mas alla de el (7.3).
      const prefijo = clave.slice(0, "tmk_live_".length + 6);

      expect(todo).toContain(prefijo);
      expect(todo).not.toContain(clave.slice(0, prefijo.length + 1));
    }
  });
});
