import { describe, expect, it } from "vitest";

import { validarEntorno, type Entorno, type EntornoCrudo } from "../src/config";

/**
 * El esquema de configuracion de la 11.2 para apps/mcp-stdio.
 *
 * La 11.2 cubre los DOS procesos, no solo web, y este ya validaba sus cuatro
 * variables —de a una, con un bloque por variable en el entrypoint—. Lo que
 * cambia es que ahora es un esquema: un solo camino, y el mensaje lista todo lo
 * que falta en vez de la primera que se encontro.
 *
 * Y DESDE EL MODO HTTP (8.1) el esquema es una UNION DISCRIMINADA por
 * MCP_PORT_MODE: cada modo pide sus propias variables y ninguna de las dos ramas
 * ve las de la otra. Lo que esta suite mide de eso son las dos direcciones, que
 * es donde estaria el error: que el modo http exija sus dos variables, y que el
 * modo core siga sin exigirlas.
 */

/** Lo minimo que arranca en modo core: la rama de siempre. */
const CORE = {
  DATABASE_URL: "postgresql://taskman:taskman@127.0.0.1:5432/taskman",
} as const;

/** Lo minimo que arranca en modo http (8.6). */
const HTTP = {
  MCP_PORT_MODE: "http",
  TASKMAN_API_URL: "https://taskman.midominio.com",
  TASKMAN_API_KEY: "tmk_live_abc123",
} as const;

/**
 * Valida y estrecha la union al modo esperado, para poder leer las variables de
 * esa rama. Que el modo sea el que se pide es parte de lo que cada caso afirma:
 * un `as` liso dejaria pasar una rama equivocada.
 */
function enModo<M extends Entorno["MCP_PORT_MODE"]>(
  modo: M,
  env: EntornoCrudo,
): Extract<Entorno, { MCP_PORT_MODE: M }> {
  const entorno = validarEntorno(env);

  expect(entorno.MCP_PORT_MODE).toBe(modo);

  return entorno as Extract<Entorno, { MCP_PORT_MODE: M }>;
}

/** El mensaje de un entorno que no valida. Falla si valida. */
function mensajeDe(env: EntornoCrudo): string {
  try {
    validarEntorno(env);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("Se esperaba que no validara, y valido.");
}

describe("validarEntorno (apps/mcp-stdio), modo core", () => {
  it("con DATABASE_URL alcanza; el modo, el log y la politica toman su defecto", () => {
    const entorno = enModo("core", CORE);

    expect(entorno.DATABASE_URL).toBe(CORE.DATABASE_URL);
    expect(entorno.LOG_LEVEL).toBe("info");
    expect(entorno.MCP_DESTRUCTIVE_POLICY).toBe("confirm");
  });

  it("sin DATABASE_URL no valida, y el mensaje dice donde definirla", () => {
    expect(() => validarEntorno({})).toThrow(/DATABASE_URL: falta/);
    expect(() => validarEntorno({})).toThrow(/\.mcp\.json/);
  });

  it("NO exige TASKMAN_API_URL ni TASKMAN_API_KEY: el modo de siempre arranca igual", () => {
    // La otra mitad de la union, y la que mas importa de las dos: agregar el
    // modo http no puede pedirle nada nuevo a quien ya tenia su `.mcp.json`.
    expect(() => validarEntorno(CORE)).not.toThrow();
  });

  it("ausente, vacia o en mayusculas, el modo es core", () => {
    for (const valor of [undefined, "", "   ", "core", "CORE", " Core "]) {
      expect(enModo("core", { ...CORE, MCP_PORT_MODE: valor }).DATABASE_URL).toBe(CORE.DATABASE_URL);
    }
  });
});

describe("validarEntorno (apps/mcp-stdio), modo http", () => {
  /**
   * LA PRUEBA INVERTIDA. Hasta el paso 13 este mismo caso afirmaba lo contrario
   * —"MCP_PORT_MODE=http no deja arrancar: esta en la 8.1 pero no
   * implementado"— porque `HttpPort` no existia y arrancar en un modo sin
   * implementacion daba un servidor que lista herramientas y falla en la primera
   * llamada. Ahora existe, asi que lo que hay que afirmar es que arranca.
   */
  it("con sus dos variables arranca, y no pide DATABASE_URL", () => {
    const entorno = enModo("http", HTTP);

    expect(entorno.TASKMAN_API_URL).toBe(HTTP.TASKMAN_API_URL);
    expect(entorno.TASKMAN_API_KEY).toBe(HTTP.TASKMAN_API_KEY);
    expect(entorno.LOG_LEVEL).toBe("info");
    expect(entorno.MCP_DESTRUCTIVE_POLICY).toBe("confirm");
  });

  it("una DATABASE_URL presente se IGNORA, no molesta", () => {
    // El caso de la maquina de desarrollo: el `.env` la tiene para todo lo
    // demas y este proceso no la usa.
    const entorno = enModo("http", { ...HTTP, ...CORE });

    expect(entorno).not.toHaveProperty("DATABASE_URL");
  });

  it("sin TASKMAN_API_URL no arranca, y el mensaje la nombra", () => {
    const mensaje = mensajeDe({ ...HTTP, TASKMAN_API_URL: undefined });

    expect(mensaje).toMatch(/TASKMAN_API_URL: falta/);
    expect(mensaje).toMatch(/\.mcp\.json/);
  });

  it("sin TASKMAN_API_KEY no arranca, y el mensaje la nombra", () => {
    const mensaje = mensajeDe({ ...HTTP, TASKMAN_API_KEY: undefined });

    expect(mensaje).toMatch(/TASKMAN_API_KEY: falta/);
    expect(mensaje).toMatch(/7\.1/);
  });

  it("vacia cuenta como ausente, en las dos", () => {
    const mensaje = mensajeDe({ ...HTTP, TASKMAN_API_URL: "  ", TASKMAN_API_KEY: "" });

    expect(mensaje).toMatch(/TASKMAN_API_URL: falta/);
    expect(mensaje).toMatch(/TASKMAN_API_KEY: falta/);
  });

  it("una TASKMAN_API_URL que no es una URL http(s) no arranca", () => {
    // Lo que se evita es un fallo en el primer `fetch` y no en el arranque, que
    // es lo que la 11.2 prohibe. `mailto:` esta porque PARSEA: comprobar que la
    // cadena es una URL no alcanza, hay que mirar el esquema.
    for (const valor of ["taskman.midominio.com", "no es una url", "mailto:yo@ejemplo.com"]) {
      expect(mensajeDe({ ...HTTP, TASKMAN_API_URL: valor })).toMatch(
        /TASKMAN_API_URL=.*se esperaba una URL absoluta/,
      );
    }
  });

  it("http:// y https://, con o sin barra final, valen las dos", () => {
    for (const valor of ["http://localhost:3000", "https://taskman.midominio.com/"]) {
      expect(enModo("http", { ...HTTP, TASKMAN_API_URL: valor }).TASKMAN_API_URL).toBe(valor);
    }
  });

  it("una variable invalida tambien impide el arranque en este modo", () => {
    // Criterio de la 11.2, y va en los DOS modos: las comunes se validan igual
    // de un lado y del otro de la union.
    expect(mensajeDe({ ...HTTP, LOG_LEVEL: "verbose" })).toMatch(/LOG_LEVEL="verbose"/);
    expect(mensajeDe({ ...HTTP, MCP_DESTRUCTIVE_POLICY: "denyy" })).toMatch(
      /MCP_DESTRUCTIVE_POLICY="denyy"/,
    );
  });
});

describe("validarEntorno (apps/mcp-stdio), lo comun a los dos modos", () => {
  it("un modo que no es ninguno de los dos no arranca, y los nombra", () => {
    const mensaje = mensajeDe({ ...CORE, MCP_PORT_MODE: "htpp" });

    expect(mensaje).toMatch(/MCP_PORT_MODE="htpp"/);
    expect(mensaje).toMatch(/core, http/);
  });

  it("una politica destructiva mal escrita no cae en el valor por defecto", () => {
    // El caso que importa: quien puso "denyy" cree tener el borrado apagado.
    const roto = { ...CORE, MCP_DESTRUCTIVE_POLICY: "denyy" };

    expect(() => validarEntorno(roto)).toThrow(/MCP_DESTRUCTIVE_POLICY="denyy"/);
    expect(() => validarEntorno(roto)).toThrow(/confirm, allow, deny/);
  });

  it("las tres politicas validas pasan", () => {
    for (const politica of ["confirm", "allow", "deny"]) {
      expect(
        validarEntorno({ ...CORE, MCP_DESTRUCTIVE_POLICY: politica }).MCP_DESTRUCTIVE_POLICY,
      ).toBe(politica);
    }
  });

  it("un LOG_LEVEL invalido no deja arrancar, con los cuatro posibles en el mensaje", () => {
    const roto = { ...CORE, LOG_LEVEL: "verbose" };

    expect(() => validarEntorno(roto)).toThrow(/LOG_LEVEL="verbose"/);
    expect(() => validarEntorno(roto)).toThrow(/debug, info, warn, error/);
  });

  it("lista TODAS las que estan mal de una vez", () => {
    const mensaje = mensajeDe({ MCP_PORT_MODE: "http", LOG_LEVEL: "verbose" });

    // Las tres en el mismo mensaje: antes eran tres arranques.
    expect(mensaje).toContain("TASKMAN_API_URL");
    expect(mensaje).toContain("TASKMAN_API_KEY");
    expect(mensaje).toContain("LOG_LEVEL");
    // Y NO nombra la del otro modo, que es lo que la union decide.
    expect(mensaje).not.toContain("DATABASE_URL");
  });

  it("un modo ilegible no tapa a las variables comunes", () => {
    /**
     * `z.discriminatedUnion` devuelve UN solo issue cuando el discriminante no
     * coincide con ninguna rama: no sabe cual validar. Sin el rescate de
     * `validarEntorno`, este entorno costaria dos arranques.
     *
     * Lo que NO puede aparecer es DATABASE_URL ni las dos del modo http: cuales
     * hacen falta es justamente lo que el modo decide, y el modo no se entiende.
     */
    const mensaje = mensajeDe({ MCP_PORT_MODE: "htpp", LOG_LEVEL: "verbose" });

    expect(mensaje).toContain("MCP_PORT_MODE");
    expect(mensaje).toContain("LOG_LEVEL");
    expect(mensaje).not.toContain("DATABASE_URL");
    expect(mensaje).not.toContain("TASKMAN_API_URL");
  });
});
