/**
 * Errores de negocio. Son parte del contrato del nucleo: los adaptadores los
 * traducen a HTTP o a respuestas MCP, pero no los interpretan de nuevo.
 */

/**
 * EL CATALOGO, como dato y no como union de tipos, y el tipo derivado de el.
 *
 * Era `type DomainErrorCode = "A" | "B" | ...`, que alcanzaba mientras el unico
 * consumidor fuera TypeScript. Dejo de alcanzar con `HttpPort` (8.1): ahi un
 * codigo llega por la red, como texto, y hay que decidir EN TIEMPO DE EJECUCION
 * si es uno de estos —y entonces se reconstruye el `DomainError` tal cual— o si
 * es algo que este proceso no conoce. Una lista escrita a mano en el borde para
 * esa comprobacion seria una segunda copia del catalogo, libre de quedarse
 * corta; derivar el tipo de la lista deja una sola.
 */
export const CODIGOS_DE_DOMINIO = [
  "BOARD_NOT_FOUND",
  "TASK_NOT_FOUND",
  "COLUMN_NOT_FOUND",
  "COLUMN_NOT_IN_BOARD",
  "INVALID_ORDER",
  // Una resolucion por nombre encontro mas de un candidato (8.3.1). El nucleo
  // NUNCA elige: devuelve la lista entera en `details` para que el llamador
  // reintente con un id concreto.
  "AMBIGUOUS_MATCH",
  // La entrada no supera el esquema de la herramienta, o falta un dato que
  // solo es obligatorio en combinacion con otro (un titulo sin tablero donde
  // buscarlo). Es del contrato del borde, no de la base.
  "VALIDATION_ERROR",
  // Una operacion destructiva se pidio sin `confirm: true` (8.3.2). No es un
  // fallo: es la mitad de un dialogo de dos pasos, y `details` lleva la tarea
  // entera para que el agente pueda mostrar que desapareceria.
  "CONFIRMATION_REQUIRED",
  // MCP_DESTRUCTIVE_POLICY=deny: el servidor no borra, se pida como se pida.
  "DESTRUCTIVE_POLICY_DENIED",
  // Una columna con tareas no se borra sin decir que hacer con ellas.
  "COLUMN_NOT_EMPTY",
  "INVALID_REASSIGN_TARGET",
  // Ya hay una columna con esa key en el tablero.
  "DUPLICATE_KEY",
  // La misma Idempotency-Key se reutilizo con un cuerpo distinto (6.5). No es
  // un fallo de la operacion: la operacion NO se ejecuto. Lo que esta mal es la
  // clave, y por eso el error no lo produce ningun servicio sino el borde, que
  // es el unico que ve la cabecera.
  "IDEMPOTENCY_MISMATCH",
  // Vacio y demasiado largo son causas distintas del mismo campo, con codigos
  // distintos a proposito: un agente tiene que poder saber si le falto
  // contenido o si le sobro. Cada limite es el del VARCHAR de su columna, y
  // existe para que el nucleo no le pase a la base algo que ella va a rechazar
  // con un 22001 opaco.
  "TITLE_REQUIRED",
  "TITLE_TOO_LONG",
  "NAME_REQUIRED",
  "NAME_TOO_LONG",
  "DESCRIPTION_TOO_LONG",
  "COLUMN_KEY_REQUIRED",
  "COLUMN_KEY_TOO_LONG",

  /**
   * LOS CUATRO DE ABAJO NO LOS PRODUCE NINGUN SERVICIO, y no son una excepcion
   * nueva: `IDEMPOTENCY_MISMATCH`, mas arriba, ya estaba en esta
   * lista con ese mismo argumento —lo produce el borde, que es el unico que ve
   * la cabecera— y `DESTRUCTIVE_POLICY_DENIED` lo produce el borde MCP. Este
   * catalogo no es "lo que sabe la base": es el vocabulario de errores que
   * llegan a un llamador como algo estructurado sobre lo que puede actuar.
   *
   * Los cuatro los produce la API REST (7.1, 7.2, 7.3) y solo aparecen en
   * `MCP_PORT_MODE=http`, donde `HttpPort` los recibe en la envoltura de la 6.4
   * y los reconstruye tal cual para que el agente los vea con su codigo, su
   * `details` y su `hint`. La alternativa era dejarlos caer en el
   * `INTERNAL_ERROR` del ejecutor, cuyo texto dice que reintentar probablemente
   * vuelva a fallar: para un 429 eso es FALSO —el cupo se libera solo— y para un
   * 403 esconde lo unico accionable, que es que scope falta.
   *
   * NO entra `INTERNAL_ERROR`, y esa ausencia es deliberada: es la ETIQUETA con
   * la que cada borde marca un fallo no controlado, no un codigo de dominio
   * (ver `deErrorInesperado` en mcp/respuesta.ts). Un 500 del servidor tiene que
   * seguir llegando por el camino de lo inesperado, que es lo que es. Tampoco
   * `FORBIDDEN_ORIGIN`, que es del transporte de /mcp y que /api nunca produce.
   */
  "UNAUTHENTICATED",
  "FORBIDDEN_SCOPE",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
] as const;

/** Los codigos del catalogo de arriba, derivados de el y no escritos aparte. */
export type DomainErrorCode = (typeof CODIGOS_DE_DOMINIO)[number];

const CONOCIDOS: ReadonlySet<string> = new Set(CODIGOS_DE_DOMINIO);

/**
 * Si un codigo que llego como TEXTO es uno del catalogo.
 *
 * Lo necesita `HttpPort`: la envoltura de la 6.4 trae `code` como string, y de
 * esa pregunta depende que el error se reconstruya como `DomainError` —o sea
 * indistinguible del que habria lanzado `CorePort`— o que suba como un fallo
 * inesperado. Vive aca, junto al catalogo, para que no pueda quedarse corta.
 */
export function esCodigoDeDominio(codigo: string): codigo is DomainErrorCode {
  return CONOCIDOS.has(codigo);
}

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
