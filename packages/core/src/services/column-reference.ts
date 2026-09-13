import type { ColumnReference } from "../domain/column-key";
import { normalizarColumnKey } from "../domain/column-key";
import { DomainError } from "../domain/errors";

/**
 * Lo minimo que hace falta para resolver una referencia a columna. Lo cumplen
 * tanto `BoardTransaction` como cualquier transaccion que sepa buscar columnas,
 * asi que la resolucion vive en UN solo lugar y no se reimplementa por servicio.
 */
export interface BuscadorDeColumnas {
  findColumn(columnId: string): Promise<{ id: string; boardId: string } | undefined>;
  findColumnByKey(boardId: string, key: string): Promise<{ id: string; boardId: string } | undefined>;
}

/**
 * Resuelve una columna por id o por key dentro del tablero.
 *
 * Si vienen las dos, `columnId` prevalece (6.3.1). La key se normaliza igual
 * que al crearla, asi que "todo" y " ToDo " resuelven a la misma columna.
 *
 * No valida que la columna pertenezca al tablero cuando se pidio por id: eso
 * es una regla de cada operacion, con su propio error (COLUMN_NOT_IN_BOARD).
 */
export async function resolverColumna(
  buscador: BuscadorDeColumnas,
  boardId: string,
  referencia: ColumnReference,
): Promise<{ id: string; boardId: string }> {
  if (referencia.columnId !== undefined) {
    const columna = await buscador.findColumn(referencia.columnId);
    if (columna === undefined) {
      throw new DomainError("COLUMN_NOT_FOUND", `No existe la columna ${referencia.columnId}.`, {
        details: { columnId: referencia.columnId },
      });
    }
    return columna;
  }

  if (referencia.columnKey !== undefined) {
    const key = normalizarColumnKey(referencia.columnKey, { boardId });
    const columna = await buscador.findColumnByKey(boardId, key);
    if (columna === undefined) {
      throw new DomainError(
        "COLUMN_NOT_FOUND",
        `El tablero ${boardId} no tiene una columna con key ${key}.`,
        {
          details: { boardId, columnKey: key },
          hint: "Consulta el tablero para ver las keys disponibles, o usa el id de la columna.",
        },
      );
    }
    return columna;
  }

  throw new DomainError("COLUMN_NOT_FOUND", "No se indico ninguna columna.", {
    details: { boardId },
    hint: "Indica columnId o columnKey.",
  });
}
