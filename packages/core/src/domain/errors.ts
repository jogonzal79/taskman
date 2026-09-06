/**
 * Errores de negocio. Son parte del contrato del nucleo: los adaptadores los
 * traducen a HTTP o a respuestas MCP, pero no los interpretan de nuevo.
 */

/** Solo los codigos que necesita `move`. Se amplia cuando llegue cada operacion. */
export type DomainErrorCode =
  | "TASK_NOT_FOUND"
  | "COLUMN_NOT_FOUND"
  | "COLUMN_NOT_IN_BOARD"
  | "INVALID_ORDER";

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
