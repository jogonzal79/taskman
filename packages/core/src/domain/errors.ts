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
  // Una resolucion por nombre encontro mas de un candidato (8.3.1). El nucleo
  // NUNCA elige: devuelve la lista entera en `details` para que el llamador
  // reintente con un id concreto.
  | "AMBIGUOUS_MATCH"
  // La entrada no supera el esquema de la herramienta, o falta un dato que
  // solo es obligatorio en combinacion con otro (un titulo sin tablero donde
  // buscarlo). Es del contrato del borde, no de la base.
  | "VALIDATION_ERROR"
  // Una operacion destructiva se pidio sin `confirm: true` (8.3.2). No es un
  // fallo: es la mitad de un dialogo de dos pasos, y `details` lleva la tarea
  // entera para que el agente pueda mostrar que desapareceria.
  | "CONFIRMATION_REQUIRED"
  // MCP_DESTRUCTIVE_POLICY=deny: el servidor no borra, se pida como se pida.
  | "DESTRUCTIVE_POLICY_DENIED"
  // Una columna con tareas no se borra sin decir que hacer con ellas.
  | "COLUMN_NOT_EMPTY"
  | "INVALID_REASSIGN_TARGET"
  // Ya hay una columna con esa key en el tablero.
  | "DUPLICATE_KEY"
  // La misma Idempotency-Key se reutilizo con un cuerpo distinto (6.5). No es
  // un fallo de la operacion: la operacion NO se ejecuto. Lo que esta mal es la
  // clave, y por eso el error no lo produce ningun servicio sino el borde, que
  // es el unico que ve la cabecera.
  | "IDEMPOTENCY_MISMATCH"
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
