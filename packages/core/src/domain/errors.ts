/**
 * Errores de negocio. Son parte del contrato del nucleo: los adaptadores los
 * traducen a HTTP o a respuestas MCP, pero no los interpretan de nuevo.
 */

/** Solo los codigos que necesitan las operaciones ya escritas. */
export type DomainErrorCode =
  | "BOARD_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "COLUMN_NOT_FOUND"
  | "COLUMN_NOT_IN_BOARD"
  | "INVALID_ORDER"
  // Una columna con tareas no se borra sin decir que hacer con ellas.
  | "COLUMN_NOT_EMPTY"
  | "INVALID_REASSIGN_TARGET"
  // Ya hay una columna con esa key en el tablero.
  | "DUPLICATE_KEY"
  // Vacio y demasiado largo son causas distintas del mismo campo, con codigos
  // distintos a proposito: un agente tiene que poder saber si le falto
  // contenido o si le sobro. Cada limite es el del VARCHAR de su columna, y
  // existe para que el nucleo no le pase a la base algo que ella va a rechazar
  // con un 22001 opaco.
  | "TITLE_REQUIRED"
  | "TITLE_TOO_LONG"
  | "NAME_REQUIRED"
  | "NAME_TOO_LONG"
  | "DESCRIPTION_TOO_LONG"
  | "COLUMN_KEY_REQUIRED"
  | "COLUMN_KEY_TOO_LONG";

export interface DomainErrorOptions {
  /** Datos estructurados para el llamador: ids involucrados, limites, etc. */
  details?: Readonly<Record<string, unknown>>;
  /** Que puede hacer quien recibe el error para corregirlo. */
  hint?: string;
  cause?: unknown;
}

export class DomainError extends Error {
  override readonly name = "DomainError";
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly hint: string | undefined;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
