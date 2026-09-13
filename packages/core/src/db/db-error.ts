/**
 * Normalizador de errores de PostgreSQL. Portado del spike F1b.0 (ver CLAUDE.md)
 * y parametrizado: el spike traia el nombre de la restriccion hardcodeado.
 *
 * La razon de existir de este archivo es el hallazgo del spike: una misma
 * violacion llega por DOS caminos segun donde falle, y el payload de la causa es
 * identico en ambos; lo unico que cambia es la clase del error y donde cuelga.
 *   - En una sentencia: PrismaClientKnownRequestError, causa en
 *     `meta.driverAdapterError.cause`.
 *   - En el COMMIT (caso tipico de una restriccion diferida): DriverAdapterError
 *     crudo, sin `code` ni `meta`, causa en `error.cause`.
 */

/** SQLSTATE de fallo de serializacion; en REPEATABLE READ obliga a reintentar. */
export const SERIALIZATION_FAILURE = "40001";

/** SQLSTATE de interbloqueo. Esta aca para nombrarlo, NO para reintentarlo. */
export const DEADLOCK_DETECTED = "40P01";

/** UNIQUE diferida que sostiene el orden denso de tareas dentro de una columna. */
export const TASK_POSITION_CONSTRAINT = "task_column_position_uniq";

/** UNIQUE diferida que sostiene el orden denso de columnas dentro de un tablero. */
export const COLUMN_POSITION_CONSTRAINT = "column_board_position_uniq";

/** Unicidad de `key` por tablero. NO es reintentable: es un error del llamador. */
export const COLUMN_KEY_CONSTRAINT = "board_column_board_id_key_key";

/**
 * PK compuesta `(key, client_id)` de `idempotency_record`.
 *
 * TAMPOCO es reintentable, y por un motivo distinto al de la anterior: la viola
 * la perdedora de dos peticiones simultaneas con la misma Idempotency-Key (6.5),
 * y reintentar solo repetiria el choque. Lo que hay que hacer con ella es leer
 * el registro que acaba de commitear la ganadora —para cuando este error llega,
 * ya esta commiteado: PostgreSQL bloquea el INSERT en conflicto hasta que la
 * otra transaccion termina— y reproducir su respuesta. Esa decision es del
 * borde, no del runner; el nombre vive aca para que el borde no lo escriba a
 * mano.
 */
export const IDEMPOTENCY_PK_CONSTRAINT = "idempotency_record_pkey";

/**
 * Las dos UNIQUE diferidas de orden, por nombre explicito. La lista se enumera
 * a proposito en vez de aceptar cualquier unicidad: `board_column_board_id_key_key`
 * tambien es una UNIQUE y reintentarla seria reintentar para siempre un error
 * real del llamador.
 */
const RESTRICCIONES_DE_ORDEN: ReadonlySet<string> = new Set([
  TASK_POSITION_CONSTRAINT,
  COLUMN_POSITION_CONSTRAINT,
]);

export interface DbFailure {
  /** Clase del error: PrismaClientKnownRequestError, DriverAdapterError... */
  ctor: string;
  /** Codigo del cliente Prisma (P2002, P2010...), ausente si fallo el COMMIT. */
  prismaCode: string | undefined;
  /** Clasificacion del driver, p. ej. "UniqueConstraintViolation". */
  kind: string | undefined;
  /** SQLSTATE de PostgreSQL. */
  sqlState: string | undefined;
  /** Restriccion violada, tomada de la causa estructurada (nunca del texto). */
  constraint: string | undefined;
  table: string | undefined;
  message: string;
}

export function describeDbFailure(error: unknown): DbFailure {
  const e = error as {
    code?: unknown;
    meta?: Record<string, unknown>;
    message?: unknown;
    cause?: unknown;
  };
  const message = String(e?.message ?? error);
  const prismaCode = typeof e?.code === "string" ? e.code : undefined;
  const ctor = (error as object)?.constructor?.name ?? typeof error;

  const meta = e?.meta ?? {};
  const anidado = meta["driverAdapterError"] as { cause?: unknown } | undefined;
  const causa = (anidado?.cause ?? e?.cause) as Record<string, unknown> | undefined;

  const leer = (clave: string): string | undefined =>
    typeof causa?.[clave] === "string" ? (causa[clave] as string) : undefined;

  const indice = (causa?.["constraint"] as { index?: unknown } | undefined)?.index;

  return {
    ctor,
    prismaCode,
    kind: leer("kind"),
    sqlState: leer("originalCode"),
    constraint: typeof indice === "string" ? indice : undefined,
    table: leer("table"),
    message,
  };
}

/** La transaccion choco con otra y hay que reintentarla desde cero. */
export function isSerializationFailure(error: unknown): boolean {
  return describeDbFailure(error).sqlState === SERIALIZATION_FAILURE;
}

/** El error viene de la restriccion indicada. El nombre lo pone el llamador. */
export function violatesConstraint(error: unknown, constraint: string): boolean {
  return describeDbFailure(error).constraint === constraint;
}

/**
 * Contencion legitima entre transacciones: reintentar con un snapshot nuevo
 * resuelve el conflicto. Son dos causas distintas del mismo fenomeno:
 *
 *   - 40001: chocamos con una fila que otra transaccion modifico despues de
 *     nuestro snapshot.
 *   - Las UNIQUE diferidas de orden: sobre una columna vacia (o un tablero sin
 *     columnas) no hay filas que bloquear, asi que dos operaciones simultaneas
 *     calculan la misma position sin verse y la restriccion las separa recien
 *     en el COMMIT.
 *
 * 40P01 NO entra, y no es un olvido: un interbloqueo significa que el orden de
 * bloqueo esta mal, y reintentarlo esconderia el bug en vez de arreglarlo.
 * Tampoco entra cualquier unicidad: solo las dos de orden, por nombre.
 */
export function isRetryableConflict(error: unknown): boolean {
  const falla = describeDbFailure(error);
  if (falla.sqlState === SERIALIZATION_FAILURE) {
    return true;
  }
  return falla.constraint !== undefined && RESTRICCIONES_DE_ORDEN.has(falla.constraint);
}
