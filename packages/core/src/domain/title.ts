import { DomainError } from "./errors.js";

/** Igual que el VARCHAR(200) de la columna. Se cuenta en code points, no en
 * unidades UTF-16: PostgreSQL cuenta caracteres, y un emoji vale 1 para el
 * VARCHAR pero 2 para `String.prototype.length`. */
export const LIMITE_TITULO = 200;

/**
 * Clase de blancos Unicode completa.
 *
 * `\s` de JavaScript ya cubre casi todo, U+00A0 incluido, pero se le escapan
 * U+0085 (NEL) y U+180E. La escribimos entera en vez de confiar en `\s` porque
 * este recorte es lo que cierra el agujero que dejo F1a: el CHECK
 * `title ~ '\S'` de la base usa la clase POSIX, que es solo ASCII, asi que
 * PostgreSQL acepta un titulo de un unico espacio duro.
 */
const BLANCOS = "\\s\\p{Zs}\\p{Zl}\\p{Zp}\\u0085\\u180E\\uFEFF";
const RECORTE = new RegExp(`^[${BLANCOS}]+|[${BLANCOS}]+$`, "gu");

export function recortarTitulo(titulo: string): string {
  return titulo.replace(RECORTE, "");
}

/**
 * Recorta y valida. Devuelve el titulo ya normalizado: quien lo llama guarda lo
 * que sale de aca, no lo que entro.
 *
 * El limite se mide DESPUES del recorte, asi que un titulo de 200 caracteres
 * rodeado de espacios se acepta.
 */
export function normalizarTitulo(titulo: string, details: Record<string, unknown>): string {
  const recortado = recortarTitulo(titulo);

  if (recortado === "") {
    throw new DomainError("TITLE_REQUIRED", "El titulo no puede estar vacio.", {
      details,
      hint: "Un titulo compuesto solo por espacios, tabulaciones o espacios duros cuenta como vacio.",
    });
  }

  // El VARCHAR(200) cuenta caracteres, no unidades UTF-16.
  const caracteres = [...recortado].length;
  if (caracteres > LIMITE_TITULO) {
    throw new DomainError(
      "TITLE_TOO_LONG",
      `El titulo tiene ${caracteres} caracteres y el maximo es ${LIMITE_TITULO}.`,
      {
        details: { ...details, length: caracteres, maxLength: LIMITE_TITULO },
        hint: "Recorta el titulo y pasa el detalle a la descripcion, que no tiene limite.",
      },
    );
  }

  return recortado;
}
