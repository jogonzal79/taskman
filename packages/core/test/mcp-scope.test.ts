import { describe, expect, it } from "vitest";

import {
  crearCorePort,
  crearHerramientas,
  POLITICAS_DESTRUCTIVAS,
  SCOPES,
  type Scope,
} from "../src/index";

/**
 * El scope de cada herramienta MCP contra la tabla de la 8.2, y el catalogo que
 * sale para cada combinacion de scopes de una clave (8.1).
 *
 * LA TABLA ESTA TRANSCRIPTA, no deducida: son las columnas Herramienta y Scope de
 * la 8.2 de `docs/especificacion-tecnica-v1.0.md`, en el orden y con la grafia del
 * documento, que escribe los scopes en minuscula. Si la 8.2 cambia, esta copia
 * cambia con ella; si cambia el codigo y la 8.2 no, esta prueba es la que se pone
 * roja.
 *
 * No invoca ningun handler: arma el registro y lee el dato, asi que no llega a
 * la base.
 */
const TABLA_8_2 = [
  ["list_boards", "read"],
  ["get_board", "read"],
  ["create_board", "write"],
  ["create_column", "write"],
  ["list_tasks", "read"],
  ["search_tasks", "read"],
  ["get_task", "read"],
  ["create_task", "write"],
  ["update_task", "write"],
  ["move_task", "write"],
  ["delete_task", "delete"],
] as const;

/**
 * Los subconjuntos NO vacios de la 7.2, calculados y no escritos a mano: con tres
 * scopes son siete, y asi no queda ninguna combinacion sin mirar.
 */
const COMBINACIONES: Scope[][] = Array.from({ length: 2 ** SCOPES.length - 1 }, (_, indice) =>
  SCOPES.filter((_scope, bit) => ((indice + 1) >> bit) & 1),
);

/**
 * Pares "herramienta scope" ordenados, y no un mapa por nombre: con un mapa, una
 * herramienta registrada dos veces se esconderia detras de la otra. Como lista,
 * sobra un par y la comparacion falla.
 */
function pares(filas: ReadonlyArray<readonly [string, string]>): string[] {
  return filas.map(([nombre, scope]) => `${nombre} ${scope}`).sort();
}

describe("scope de las herramientas (8.2)", () => {
  it("las once declaran el scope de la tabla, con cualquier MCP_DESTRUCTIVE_POLICY", () => {
    // delete_task arma su definicion segun la politica (8.3.2) y con `deny` sigue
    // registrada aunque no se anuncie. El scope no puede variar con eso: lo que
    // exige la clave no depende de lo que el servidor permita.
    for (const politicaDestructiva of POLITICAS_DESTRUCTIVAS) {
      const declarados = crearHerramientas(crearCorePort(), {
        scopes: SCOPES,
        politicaDestructiva,
      }).map((herramienta) => [herramienta.name, herramienta.scope.toLowerCase()] as const);

      expect(pares(declarados), `MCP_DESTRUCTIVE_POLICY=${politicaDestructiva}`).toEqual(
        pares(TABLA_8_2),
      );
    }
  });
});

describe("herramientas por scopes de la clave (8.1)", () => {
  it("cada combinacion de scopes devuelve exactamente las filas de la tabla con esos scopes", () => {
    expect(COMBINACIONES).toHaveLength(7);

    // Por las tres politicas: con `deny`, delete_task sigue en la lista si la
    // clave tiene delete, porque la politica marca y no omite. Si la politica
    // sacara algo, o los scopes dejaran pasar algo de mas, falla la combinacion
    // que lo muestra y el mensaje la nombra.
    for (const politicaDestructiva of POLITICAS_DESTRUCTIVAS) {
      for (const scopes of COMBINACIONES) {
        const devueltos = crearHerramientas(crearCorePort(), { scopes, politicaDestructiva }).map(
          (herramienta) => [herramienta.name, herramienta.scope.toLowerCase()] as const,
        );
        const conEsosScopes = TABLA_8_2.filter(([, scope]) =>
          scopes.some((tiene) => tiene.toLowerCase() === scope),
        );

        expect(pares(devueltos), `[${scopes.join(", ")}] con ${politicaDestructiva}`).toEqual(
          pares(conEsosScopes),
        );
      }
    }
  });

  it("sin ningun scope no devuelve un catalogo vacio: falla al armarlo", () => {
    // Con el SDK, un servidor sin herramientas responde "Method not found" a
    // tools/list en vez de una lista vacia (ver `crearHerramientas`).
    expect(() => crearHerramientas(crearCorePort(), { scopes: [] })).toThrow(
      "Ninguna herramienta MCP admite los scopes []",
    );
  });
});
