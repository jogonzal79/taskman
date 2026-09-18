import { describe, expect, it } from "vitest";

import { limiteHabilitado, validarEntorno } from "../lib/config";

/**
 * El esquema de configuracion de la 11.2 para apps/web.
 *
 * No toca la base ni el entorno del proceso: `validarEntorno` recibe el entorno
 * como argumento, que es lo que permite probar cada variable por separado sin
 * escribir en `process.env` —y lo que evita que importar el modulo valide nada,
 * de lo que depende que `next build` siga funcionando sin base ni pepper—.
 *
 * Las aserciones miran el MENSAJE y no solo que lance: un fallo de arranque que no
 * nombra la variable manda a leer el esquema, que es justo lo que no se quiere
 * estar haciendo cuando un servicio no levanta.
 */

const COMPLETO = {
  DATABASE_URL: "postgresql://taskman:taskman@127.0.0.1:5432/taskman",
  API_KEY_PEPPER: "un-pepper-cualquiera",
} as const;

describe("validarEntorno (apps/web)", () => {
  it("con las dos obligatorias alcanza, y el resto toma sus valores por defecto", () => {
    const entorno = validarEntorno(COMPLETO);

    expect(entorno.DATABASE_URL).toBe(COMPLETO.DATABASE_URL);
    expect(entorno.API_KEY_PEPPER).toBe(COMPLETO.API_KEY_PEPPER);
    // 11.2: sin configurar, `info`. Y el limite de la 7.3 ENCENDIDO.
    expect(entorno.LOG_LEVEL).toBe("info");
    expect(entorno.RATE_LIMIT_ENABLED).toBe(true);
    // 8.3.2: sin configurar, se pregunta antes de borrar.
    expect(entorno.MCP_DESTRUCTIVE_POLICY).toBe("confirm");
    expect(entorno.NODE_ENV).toBeUndefined();
  });

  it("sin API_KEY_PEPPER no valida, y el mensaje la nombra", () => {
    const { API_KEY_PEPPER: _sin, ...resto } = COMPLETO;

    expect(() => validarEntorno(resto)).toThrow(/API_KEY_PEPPER: falta/);
    // Y dice para que sirve, no solo que falta.
    expect(() => validarEntorno(resto)).toThrow(/hash de las API keys/);
  });

  it("con API_KEY_PEPPER en blanco tampoco: ausente y vacia son el mismo caso", () => {
    expect(() => validarEntorno({ ...COMPLETO, API_KEY_PEPPER: "   " })).toThrow(
      /API_KEY_PEPPER/,
    );
  });

  it("sin DATABASE_URL no valida, y el mensaje la nombra", () => {
    const { DATABASE_URL: _sin, ...resto } = COMPLETO;

    expect(() => validarEntorno(resto)).toThrow(/DATABASE_URL: falta/);
    expect(() => validarEntorno(resto)).toThrow(/PostgreSQL/);
  });

  it("lista TODAS las que faltan de una vez, no de a una por reinicio", () => {
    let mensaje = "";

    try {
      validarEntorno({});
    } catch (error: unknown) {
      mensaje = error instanceof Error ? error.message : String(error);
    }

    expect(mensaje).toContain("DATABASE_URL");
    expect(mensaje).toContain("API_KEY_PEPPER");
    expect(mensaje).toContain("Copia .env.example a .env");
  });

  it("un LOG_LEVEL invalido no valida, y el mensaje dice los cuatro posibles", () => {
    const roto = { ...COMPLETO, LOG_LEVEL: "verbose" };

    // El valor recibido va en el mensaje: sin el, hay que ir a buscar que estaba
    // configurado.
    expect(() => validarEntorno(roto)).toThrow(/LOG_LEVEL="verbose"/);
    expect(() => validarEntorno(roto)).toThrow(/debug, info, warn, error/);
  });

  it("los cuatro niveles validos pasan, y se normalizan", () => {
    for (const nivel of ["debug", "info", "warn", "error"]) {
      expect(validarEntorno({ ...COMPLETO, LOG_LEVEL: nivel }).LOG_LEVEL).toBe(nivel);
    }

    // El vocabulario es el del nucleo, que recorta y baja a minusculas.
    expect(validarEntorno({ ...COMPLETO, LOG_LEVEL: " DEBUG " }).LOG_LEVEL).toBe("debug");
  });

  it("un RATE_LIMIT_ENABLED invalido no valida: `flase` no puede pasar por apagado", () => {
    const roto = { ...COMPLETO, RATE_LIMIT_ENABLED: "flase" };

    expect(() => validarEntorno(roto)).toThrow(/RATE_LIMIT_ENABLED="flase"/);
    expect(() => validarEntorno(roto)).toThrow(/exactamente "true" o "false"/);
  });

  it("RATE_LIMIT_ENABLED true/false se traduce al booleano del limite", () => {
    expect(validarEntorno({ ...COMPLETO, RATE_LIMIT_ENABLED: "false" }).RATE_LIMIT_ENABLED).toBe(
      false,
    );
    expect(validarEntorno({ ...COMPLETO, RATE_LIMIT_ENABLED: "true" }).RATE_LIMIT_ENABLED).toBe(
      true,
    );
  });

  it("un MCP_DESTRUCTIVE_POLICY invalido no valida: `denyy` no puede pasar por el defecto", () => {
    const roto = { ...COMPLETO, MCP_DESTRUCTIVE_POLICY: "denyy" };

    // Quien escribio "denyy" cree tener el borrado apagado; caer en `confirm` se
    // lo dejaria encendido sin avisar.
    expect(() => validarEntorno(roto)).toThrow(/MCP_DESTRUCTIVE_POLICY="denyy"/);
    expect(() => validarEntorno(roto)).toThrow(/confirm, allow, deny/);
  });

  it("MCP_DESTRUCTIVE_POLICY en blanco es ausente: queda en confirm", () => {
    expect(
      validarEntorno({ ...COMPLETO, MCP_DESTRUCTIVE_POLICY: "  " }).MCP_DESTRUCTIVE_POLICY,
    ).toBe("confirm");
  });

  it("las tres politicas validas pasan, y se normalizan", () => {
    for (const politica of ["confirm", "allow", "deny"]) {
      expect(
        validarEntorno({ ...COMPLETO, MCP_DESTRUCTIVE_POLICY: politica }).MCP_DESTRUCTIVE_POLICY,
      ).toBe(politica);
    }

    // El vocabulario es el del nucleo, el mismo que usa apps/mcp-stdio.
    expect(
      validarEntorno({ ...COMPLETO, MCP_DESTRUCTIVE_POLICY: " Deny " }).MCP_DESTRUCTIVE_POLICY,
    ).toBe("deny");
  });

  it("un NODE_ENV que no es uno de los tres no valida", () => {
    expect(() => validarEntorno({ ...COMPLETO, NODE_ENV: "prod" })).toThrow(/NODE_ENV="prod"/);
    expect(validarEntorno({ ...COMPLETO, NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("`limiteHabilitado` es la regla que comparten el esquema y el limite", () => {
    // La misma funcion decide en el arranque y en la peticion: dos
    // interpretaciones del mismo valor podrian dejar pasar el arranque y
    // significar lo contrario despues.
    expect(limiteHabilitado(undefined)).toBe(true);
    expect(limiteHabilitado("true")).toBe(true);
    expect(limiteHabilitado("false")).toBe(false);
    expect(limiteHabilitado(" FALSE ")).toBe(false);
  });
});
