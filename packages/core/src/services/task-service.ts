import type { LockedTask, MoveTransaction, TaskRepository } from "../db/task-repository.js";
import { DomainError } from "../domain/errors.js";
import { assertValidPosition, computeMoveOrder } from "../domain/order.js";
import type { ColumnOrder, MoveResult, MoveTarget } from "../domain/types.js";

/** Agrupa las filas bloqueadas por columna, cada una ordenada por `position`. */
function agruparPorColumna(filas: readonly LockedTask[]): Map<string, string[]> {
  const porColumna = new Map<string, LockedTask[]>();

  for (const fila of filas) {
    const lista = porColumna.get(fila.columnId);
    if (lista === undefined) {
      porColumna.set(fila.columnId, [fila]);
    } else {
      lista.push(fila);
    }
  }

  const orden = new Map<string, string[]>();
  for (const [columnId, lista] of porColumna) {
    // Las filas llegan en orden de bloqueo (column_id, id), no de position.
    const ordenadas = [...lista].sort((a, b) => a.position - b.position);
    orden.set(columnId, ordenadas.map((fila) => fila.id));
  }
  return orden;
}

export class TaskService {
  readonly #tasks: TaskRepository;

  constructor(tasks: TaskRepository) {
    this.#tasks = tasks;
  }

  /**
   * Mueve una tarea a una columna y posicion del mismo tablero.
   *
   * Todo ocurre en una transaccion REPEATABLE READ que reescribe la secuencia
   * completa 0..n-1 de cada columna afectada. Mover dentro de la misma columna
   * no es una rama aparte: es el mismo calculo con origen igual a destino.
   */
  async move(taskId: string, target: MoveTarget): Promise<MoveResult> {
    return this.#tasks.inMoveTransaction(async (tx) => this.#move(tx, taskId, target));
  }

  async #move(tx: MoveTransaction, taskId: string, target: MoveTarget): Promise<MoveResult> {
    // Pasos 1 y 3 del algoritmo, en una sola sentencia y en orden canonico.
    // Ver el comentario de `lockTaskAndColumns`: separarlos reintroduce el
    // interbloqueo que el orden de bloqueo existe para evitar.
    const bloqueadas = await tx.lockTaskAndColumns(taskId, target.columnId);

    const actual = bloqueadas.find((fila) => fila.id === taskId);
    if (actual === undefined) {
      throw new DomainError("TASK_NOT_FOUND", `No existe la tarea ${taskId}.`, {
        details: { taskId },
      });
    }

    // Paso 2. La FK compuesta ya impide cruzar tableros, pero un error de
    // dominio explicito le dice al llamador que hizo mal.
    const destino = await tx.findColumn(target.columnId);
    if (destino === undefined) {
      throw new DomainError("COLUMN_NOT_FOUND", `No existe la columna ${target.columnId}.`, {
        details: { columnId: target.columnId },
      });
    }
    if (destino.boardId !== actual.boardId) {
      throw new DomainError(
        "COLUMN_NOT_IN_BOARD",
        `La columna ${target.columnId} pertenece a otro tablero que la tarea ${taskId}.`,
        {
          details: {
            taskId,
            columnId: target.columnId,
            taskBoardId: actual.boardId,
            columnBoardId: destino.boardId,
          },
          hint: "Una tarea solo se mueve entre columnas de su propio tablero.",
        },
      );
    }

    // Paso 4.
    assertValidPosition(target.position, taskId);

    const ordenNuevo = computeMoveOrder({
      taskId,
      fromColumnId: actual.columnId,
      toColumnId: target.columnId,
      currentOrder: agruparPorColumna(bloqueadas),
      position: target.position,
    });

    // Paso 5: secuencia completa de cada columna afectada, nunca diferencias.
    for (const [columnId, taskIds] of ordenNuevo) {
      await tx.rewriteColumn(columnId, taskIds);
    }

    const tarea = await tx.readTask(taskId);
    if (tarea === undefined) {
      // Inalcanzable: la fila esta bloqueada por esta misma transaccion.
      throw new DomainError("TASK_NOT_FOUND", `No existe la tarea ${taskId}.`, {
        details: { taskId },
      });
    }

    // El orden que devolvemos se relee de la base, no se asume del calculo.
    const columnasAfectadas =
      actual.columnId === target.columnId ? [target.columnId] : [actual.columnId, target.columnId];

    const affectedColumns: ColumnOrder[] = [];
    for (const columnId of columnasAfectadas) {
      affectedColumns.push({ columnId, taskIds: await tx.readColumnOrder(columnId) });
    }

    return {
      task: tarea,
      fromColumnId: actual.columnId,
      toColumnId: target.columnId,
      affectedColumns,
    };
  }
}
