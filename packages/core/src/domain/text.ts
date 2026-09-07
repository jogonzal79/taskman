import { DomainError, type DomainErrorCode } from "./errors.js";

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
const BLANCOS_INTERNOS = new RegExp(`[${BLANCOS}]+`, "gu");

export function recortarBlancos(valor: string): string {
  return valor.replace(RECORTE, "");
}

/** Colapsa cualquier corrida de blancos internos en un unico separador. */
export function reemplazarBlancosInternos(valor: string, separador: string): string {
  return valor.replace(BLANCOS_INTERNOS, separador);
}

/**
 * Los limites se miden en code points, no en unidades UTF-16: PostgreSQL cuenta
 * caracteres, y un emoji vale 1 para un VARCHAR pero 2 para `String.length`.
 */
export function contarCaracteres(valor: string): number {
  return [...valor].length;
}

export interface ReglaTexto {
  /** Nombre del campo, para el `details` del error. */
  campo: string;
  /** Igual al VARCHAR de la columna correspondiente. */
  maxLength: number;
  vacio: DomainErrorCode;
  largo: DomainErrorCode;
}

/**
 * Recorta y valida. Devuelve el texto ya normalizado: quien lo llama guarda lo
 * que sale de aca, no lo que entro. El limite se mide DESPUES del recorte, asi
 * que un valor que llega al maximo rodeado de espacios se acepta.
 */
export function normalizarTexto(
  valor: string,
  regla: ReglaTexto,
  details: Readonly<Record<string, unknown>> = {},
): string {
  const recortado = recortarBlancos(valor);

  if (recortado === "") {
    throw new DomainError(regla.vacio, `El campo ${regla.campo} no puede estar vacio.`, {
      details: { ...details, field: regla.campo },
      hint: "Un valor compuesto solo por espacios, tabulaciones o espacios duros cuenta como vacio.",
    });
  }

  const caracteres = contarCaracteres(recortado);
  if (caracteres > regla.maxLength) {
    throw new DomainError(
      regla.largo,
      `El campo ${regla.campo} tiene ${caracteres} caracteres y el maximo es ${regla.maxLength}.`,
      {
        details: { ...details, field: regla.campo, length: caracteres, maxLength: regla.maxLength },
        hint: "Recorta el valor: la base lo rechazaria con un error opaco de truncamiento.",
      },
    );
  }

  return recortado;
}
