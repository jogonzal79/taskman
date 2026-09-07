import { DomainError } from "./errors.js";
import { contarCaracteres, recortarBlancos, reemplazarBlancosInternos } from "./text.js";

/** Iguales a los VARCHAR de `board_column`. */
export const LIMITE_COLUMN_KEY = 40;
export const LIMITE_COLUMN_NAME = 80;

/**
 * Normaliza la key de una columna: recortada, en mayusculas y sin espacios,
 * como pide la 5.2.
 *
 * Los blancos internos se colapsan en `_` en vez de desaparecer, para que
 * "en progreso" quede `EN_PROGRESO` y no `ENPROGRESO`. Es la forma de las
 * cuatro keys por defecto de la 4.3, y las keys son parte del contrato con los
 * agentes: se resuelven por nombre, asi que conviene que sean predecibles.
 */
export function normalizarColumnKey(key: string, details: Record<string, unknown> = {}): string {
  const normalizada = reemplazarBlancosInternos(recortarBlancos(key), "_").toUpperCase();

  if (normalizada === "") {
    throw new DomainError("COLUMN_KEY_REQUIRED", "La key de la columna no puede estar vacia.", {
      details: { ...details, field: "key" },
      hint: "La key identifica la columna para los agentes: usa algo como TODO o IN_PROGRESS.",
    });
  }

  const caracteres = contarCaracteres(normalizada);
  if (caracteres > LIMITE_COLUMN_KEY) {
    throw new DomainError(
      "COLUMN_KEY_TOO_LONG",
      `La key tiene ${caracteres} caracteres y el maximo es ${LIMITE_COLUMN_KEY}.`,
      {
        details: { ...details, field: "key", length: caracteres, maxLength: LIMITE_COLUMN_KEY },
      },
    );
  }

  return normalizada;
}

/**
 * Referencia a una columna: por id o por key dentro del tablero.
 *
 * Existe para que un agente pueda decir "TODO" sin una consulta previa de
 * resolucion. Si vienen las dos, `columnId` prevalece (6.3.1).
 */
export interface ColumnReference {
  columnId?: string;
  columnKey?: string;
}
