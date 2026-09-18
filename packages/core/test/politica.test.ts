import { describe, expect, it } from "vitest";

import {
  leerPoliticaDestructiva,
  POLITICA_DESTRUCTIVA_POR_DEFECTO,
  POLITICAS_DESTRUCTIVAS,
} from "../src/index";

/**
 * MCP_DESTRUCTIVE_POLICY (8.3.2 y 11.2). No toca la base: la validacion de
 * configuracion es una funcion pura, y probarla contra PostgreSQL no la haria
 * mas cierta.
 */

describe("leerPoliticaDestructiva", () => {
  it("acepta los tres valores de la 8.3.2", () => {
    for (const valor of POLITICAS_DESTRUCTIVAS) {
      expect(leerPoliticaDestructiva(valor)).toBe(valor);
    }
  });

  it("ausente o vacia es confirm", () => {
    // La 8.3.2 fija el valor por defecto: sin configurar, se pregunta.
    expect(POLITICA_DESTRUCTIVA_POR_DEFECTO).toBe("confirm");
    expect(leerPoliticaDestructiva(undefined)).toBe("confirm");
    expect(leerPoliticaDestructiva("")).toBe("confirm");
    // Un bloque env de .mcp.json con la clave puesta y el valor sin completar
    // es lo mismo que no haberla puesto, no un error de configuracion.
    expect(leerPoliticaDestructiva("   ")).toBe("confirm");
  });

  it("normaliza espacios y mayusculas", () => {
    // "Deny" es la misma intencion escrita a mano. Aceptarla no puede
    // convertir una politica en otra, y rechazarla solo agrega un rodeo.
    expect(leerPoliticaDestructiva("  DENY ")).toBe("deny");
    expect(leerPoliticaDestructiva("Allow")).toBe("allow");
  });

  it("un valor invalido lanza con el valor recibido y la lista de posibles", () => {
    // Lo que hace util al mensaje es que diga que se leyo: la variable suele
    // venir de un .mcp.json que el usuario no esta mirando.
    expect(() => leerPoliticaDestructiva("denyy")).toThrow(/denyy/);
    expect(() => leerPoliticaDestructiva("denyy")).toThrow(/confirm, allow, deny/);
  });

  it("no cae al valor por defecto ante un valor invalido", () => {
    // Es la diferencia entre no arrancar y arrancar mintiendo: quien escribio
    // "none" cree tener el borrado apagado y lo tendria encendido.
    expect(() => leerPoliticaDestructiva("none")).toThrow();
    expect(() => leerPoliticaDestructiva("true")).toThrow();
    expect(() => leerPoliticaDestructiva("confirm allow")).toThrow();
  });
});
