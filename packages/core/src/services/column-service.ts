import { randomUUID } from "node:crypto";

import type { BoardRepository, BoardTransaction, LockedColumn } from "../db/board-repository.js";
import { LIMITE_COLUMN_NAME, normalizarColumnKey } from "../domain/column-key.js";
import { DomainError } from "../domain/errors.js";
import { assertValidPosition } from "../domain/order.js";
import { normalizarTexto } from "../domain/text.js";
import type {
  Column,
  CreateColumnInput,
  DeleteColumnOptions,
  TargetPosition,
  UpdateColumnInput,
} from "../domain/types.js";

/** Saca el elemento de la lista y lo reinserta en la posicion pedida. */
function reubicar(ids: readonly string[], id: string, position: TargetPosition): string[] {
  const resto = ids.filter((otro) => otro !== id);
  // Una posicion mayor que la lista se ajusta al final, igual que en `move`.
  const indice = position === "end" ? resto.length : Math.min(position, resto.length);
  resto.splice(indice, 0, id);
  return resto;
}

/** Las filas llegan en orden de bloqueo `(board_id, id)`, no de `position`. */
function ordenarPorPosicion(filas: readonly LockedColumn[]): string[] {
  return [...filas].sort((a, b) => a.position - b.position).map((fila) => fila.id);
}

function normalizarNombre(nombre: string, details: Record<string, unknown>): string {
  return normalizarTexto(
    nombre,
    {
      campo: "name",
      maxLength: LIMITE_COLUMN_NAME,
      vacio: "NAME_REQUIRED",
      largo: "NAME_TOO_LONG",
    },
    details,
  );
}

function columnaNoEncontrada(columnId: string): DomainError {
  return new DomainError("COLUMN_NOT_FOUND", `No existe la columna ${columnId}.`, {
    details: { columnId },
  });
}

export class ColumnService {
  readonly #boards: BoardRepository;

  constructor(boards: BoardRepository) {
    this.#boards = boards;
  }

  /**
   * Crea una columna en el tablero. La key se normaliza a mayusculas sin
   * espacios y tiene que ser unica dentro del tablero (5.2).
   */
  async create(input: CreateColumnInput): Promise<Column> {
    const detalle = { boardId: input.boardId };
    const name = normalizarNombre(input.name, detalle);
    const key = normalizarColumnKey(input.key, detalle);
    const position = input.position ?? "end";
    assertValidPosition(position, detalle);

    return this.#boards.inTransaction(async (tx) => {
      const tablero = await tx.findBoard(input.boardId);
      if (tablero === undefined) {
        throw new DomainError("BOARD_NOT_FOUND", `No existe el tablero ${input.boardId}.`, {
          details: detalle,
        });
      }

      // Chequeo explicito antes de insertar: el indice unico daria el mismo
      // resultado, pero como un error opaco de base en vez de uno accionable.
      const existente = await tx.findColumnByKey(input.boardId, key);
      if (existente !== undefined) {
        throw new DomainError(
          "DUPLICATE_KEY",
          `El tablero ${input.boardId} ya tiene una columna con key ${key}.`,
          {
            details: { ...detalle, columnKey: key, columnId: existente.id },
            hint: "Usa otra key, o actualiza la columna existente.",
          },
        );
      }

      const existentes = ordenarPorPosicion(await tx.lockBoardColumns(input.boardId));
      const indice =
        position === "end" ? existentes.length : Math.min(position, existentes.length);

      const id = randomUUID();
      const orden = [...existentes];
      orden.splice(indice, 0, id);

      await tx.insertColumn({ id, boardId: input.boardId, name, key, position: indice });
      await tx.rewriteBoardColumns(input.boardId, orden);

      return this.#leer(tx, id);
    });
  }

  /**
   * Renombra o reordena (6.2). La `key` no se toca: los agentes resuelven
   * referencias con ella, asi que es estable por diseno.
   */
  async update(columnId: string, patch: UpdateColumnInput): Promise<Column> {
    return this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findColumn(columnId);
      if (actual === undefined) {
        throw columnaNoEncontrada(columnId);
      }

      if (patch.name !== undefined) {
        const name = normalizarNombre(patch.name, { columnId });
        if (name !== actual.name) {
          await tx.updateColumnName(columnId, name);
        }
      }

      if (patch.position !== undefined) {
        assertValidPosition(patch.position, { columnId });
        const existentes = ordenarPorPosicion(await tx.lockBoardColumns(actual.boardId));
        // Secuencia completa, nunca diferencias: es la misma regla que el
        // orden de tareas y es lo que impide que queden huecos.
        await tx.rewriteBoardColumns(actual.boardId, reubicar(existentes, columnId, patch.position));
      }

      return this.#leer(tx, columnId);
    });
  }

  /**
   * Elimina la columna y reindexa el tablero.
   *
   * Con tareas dentro falla con COLUMN_NOT_EMPTY, salvo que se indique
   * `reassignTo`: en ese caso las tareas se mueven al final de esa columna en
   * la MISMA transaccion, asi que nunca hay un instante con tareas huerfanas ni
   * con la columna a medio borrar.
   */
  async delete(columnId: string, options: DeleteColumnOptions = {}): Promise<void> {
    await this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findColumn(columnId);
      if (actual === undefined) {
        throw columnaNoEncontrada(columnId);
      }

      const tareas = await tx.countTasksInColumn(columnId);
      if (tareas > 0) {
        await this.#reasignar(tx, actual, tareas, options.reassignTo);
      }

      const existentes = ordenarPorPosicion(await tx.lockBoardColumns(actual.boardId));
      await tx.deleteColumn(columnId);
      await tx.rewriteBoardColumns(
        actual.boardId,
        existentes.filter((id) => id !== columnId),
      );
    });
  }

  async #reasignar(
    tx: BoardTransaction,
    origen: Column,
    tareas: number,
    reassignTo: string | undefined,
  ): Promise<void> {
    if (reassignTo === undefined) {
      throw new DomainError(
        "COLUMN_NOT_EMPTY",
        `La columna ${origen.id} tiene ${tareas} tareas.`,
        {
          details: { columnId: origen.id, taskCount: tareas },
          hint: "Indica reassignTo con otra columna del mismo tablero para mover las tareas antes de borrar.",
        },
      );
    }

    if (reassignTo === origen.id) {
      throw new DomainError(
        "INVALID_REASSIGN_TARGET",
        "reassignTo no puede ser la columna que se esta eliminando.",
        {
          details: { columnId: origen.id, reassignTo },
          hint: "Indica otra columna del mismo tablero.",
        },
      );
    }

    const destino = await tx.findColumn(reassignTo);
    if (destino === undefined) {
      throw columnaNoEncontrada(reassignTo);
    }
    if (destino.boardId !== origen.boardId) {
      throw new DomainError(
        "COLUMN_NOT_IN_BOARD",
        `La columna ${reassignTo} pertenece a otro tablero.`,
        {
          details: {
            columnId: origen.id,
            reassignTo,
            boardId: origen.boardId,
            reassignBoardId: destino.boardId,
          },
          hint: "Las tareas solo pueden reasignarse a una columna del mismo tablero.",
        },
      );
    }

    // Bloqueo de las tareas de ambas columnas en una sola sentencia y en orden
    // canonico, igual que `move`: si dos operaciones tomaran estas filas en
    // ordenes distintos volveria el interbloqueo.
    const bloqueadas = await tx.lockTasksOfColumns([origen.id, destino.id]);
    const porColumna = (id: string): string[] =>
      bloqueadas
        .filter((fila) => fila.columnId === id)
        .sort((a, b) => a.position - b.position)
        .map((fila) => fila.id);

    // Las de la columna que se va quedan al final de la destino, en su orden.
    await tx.rewriteTaskColumn(destino.id, [...porColumna(destino.id), ...porColumna(origen.id)]);
  }

  async #leer(tx: BoardTransaction, columnId: string): Promise<Column> {
    const columna = await tx.findColumn(columnId);
    if (columna === undefined) {
      throw columnaNoEncontrada(columnId);
    }
    return columna;
  }
}
