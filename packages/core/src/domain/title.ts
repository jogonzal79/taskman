import { normalizarTexto, recortarBlancos } from "./text.js";

/**
 * Igual que el VARCHAR(200) de la columna. Se cuenta en code points, no en
 * unidades UTF-16.
 */
export const LIMITE_TITULO = 200;

/** El recorte generico, con el nombre que usa el resto del nucleo. */
export const recortarTitulo = recortarBlancos;

/**
 * Recorta y valida el titulo de una tarea. Ver `normalizarTexto`: el limite se
 * mide despues del recorte, y son dos codigos distintos porque un agente tiene
 * que poder saber si le falto contenido o si le sobro.
 */
export function normalizarTitulo(titulo: string, details: Record<string, unknown>): string {
  return normalizarTexto(
    titulo,
    {
      campo: "title",
      maxLength: LIMITE_TITULO,
      vacio: "TITLE_REQUIRED",
      largo: "TITLE_TOO_LONG",
    },
    details,
  );
}
