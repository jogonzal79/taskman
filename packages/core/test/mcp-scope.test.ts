import { describe, expect, it } from "vitest";

import { crearCorePort, crearHerramientas, POLITICAS_DESTRUCTIVAS } from "../src/index";

/**
 * El scope de cada herramienta MCP contra la tabla de la 8.2.
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
      const declarados = crearHerramientas(crearCorePort(), { politicaDestructiva }).map(
        (herramienta) => [herramienta.name, herramienta.scope.toLowerCase()] as const,
      );

      expect(pares(declarados), `MCP_DESTRUCTIVE_POLICY=${politicaDestructiva}`).toEqual(
        pares(TABLA_8_2),
      );
    }
  });
});
