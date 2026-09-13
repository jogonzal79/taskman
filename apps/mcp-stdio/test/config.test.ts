import { describe, expect, it } from "vitest";

import { validarEntorno } from "../src/config";

/**
 * El esquema de configuracion de la 11.2 para apps/mcp-stdio.
 *
 * La 11.2 cubre los DOS procesos, no solo web, y este ya validaba sus cuatro
 * variables —de a una, con un bloque por variable en el entrypoint—. Lo que
 * cambia es que ahora es un esquema: un solo camino, y el mensaje lista todo lo
 * que falta en vez de la primera que se encontro.
 */

const COMPLETO = {
  DATABASE_URL: "postgresql://taskman:taskman@127.0.0.1:5432/taskman",
} as const;

describe("validarEntorno (apps/mcp-stdio)", () => {
  it("con DATABASE_URL alcanza; el modo, el log y la politica toman su defecto", () => {
    const entorno = validarEntorno(COMPLETO);

    expect(entorno.DATABASE_URL).toBe(COMPLETO.DATABASE_URL);
    expect(entorno.MCP_PORT_MODE).toBe("core");
    expect(entorno.LOG_LEVEL).toBe("info");
    expect(entorno.MCP_DESTRUCTIVE_POLICY).toBe("confirm");
  });

  it("sin DATABASE_URL no valida, y el mensaje dice donde definirla", () => {
    expect(() => validarEntorno({})).toThrow(/DATABASE_URL: falta/);
    expect(() => validarEntorno({})).toThrow(/\.mcp\.json/);
  });

  it("MCP_PORT_MODE=http no deja arrancar: esta en la 8.1 pero no implementado", () => {
    const roto = { ...COMPLETO, MCP_PORT_MODE: "http" };

    expect(() => validarEntorno(roto)).toThrow(/MCP_PORT_MODE="http"/);
    expect(() => validarEntorno(roto)).toThrow(/todavia no esta implementado/);
  });

  it("una politica destructiva mal escrita no cae en el valor por defecto", () => {
    // El caso que importa: quien puso "denyy" cree tener el borrado apagado.
    const roto = { ...COMPLETO, MCP_DESTRUCTIVE_POLICY: "denyy" };

    expect(() => validarEntorno(roto)).toThrow(/MCP_DESTRUCTIVE_POLICY="denyy"/);
    expect(() => validarEntorno(roto)).toThrow(/confirm, allow, deny/);
  });

  it("las tres politicas validas pasan", () => {
    for (const politica of ["confirm", "allow", "deny"]) {
      expect(
        validarEntorno({ ...COMPLETO, MCP_DESTRUCTIVE_POLICY: politica }).MCP_DESTRUCTIVE_POLICY,
      ).toBe(politica);
    }
  });

  it("un LOG_LEVEL invalido no deja arrancar, con los cuatro posibles en el mensaje", () => {
    const roto = { ...COMPLETO, LOG_LEVEL: "verbose" };

    expect(() => validarEntorno(roto)).toThrow(/LOG_LEVEL="verbose"/);
    expect(() => validarEntorno(roto)).toThrow(/debug, info, warn, error/);
  });

  it("lista TODAS las que estan mal de una vez", () => {
    let mensaje = "";

    try {
      validarEntorno({ MCP_PORT_MODE: "http", LOG_LEVEL: "verbose" });
    } catch (error: unknown) {
      mensaje = error instanceof Error ? error.message : String(error);
    }

    // Las tres en el mismo mensaje: antes eran tres arranques.
    expect(mensaje).toContain("MCP_PORT_MODE");
    expect(mensaje).toContain("DATABASE_URL");
    expect(mensaje).toContain("LOG_LEVEL");
  });
});
