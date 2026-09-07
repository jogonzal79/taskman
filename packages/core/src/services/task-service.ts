import { randomUUID } from "node:crypto";

import type {
  LockedTask,
  MoveTransaction,
  TaskFields,
  TaskRepository,
} from "../db/task-repository.js";
import { DomainError } from "../domain/errors.js";
import { assertValidPosition, computeMoveOrder } from "../domain/order.js";
import { normalizarTitulo } from "../domain/title.js";
import type {
  ColumnOrder,
  CreateTaskInput,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  SearchScope,
  Task,
  TaskMatch,
  UpdateTaskInput,
} from "../domain/types.js";

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
    orden.set(columnId, ordenarPorPosicion(lista));
  }
  return orden;
}

/** Las filas llegan en orden de bloqueo `(column_id, id)`, no de `position`. */
function ordenarPorPosicion(filas: readonly LockedTask[]): string[] {
  return [...filas].sort((a, b) => a.position - b.position).map((fila) => fila.id);
}

function mismaFecha(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.getTime() === b.getTime();
}

function sinCambioEfectivo(actual: Task, siguiente: TaskFields): boolean {
  return (
    actual.title === siguiente.title &&
    actual.description === siguiente.description &&
    actual.priority === siguiente.priority &&
    mismaFecha(actual.dueDate, siguiente.dueDate)
  );
}

function tareaNoEncontrada(taskId: string): DomainError {
  return new DomainError("TASK_NOT_FOUND", `No existe la tarea ${taskId}.`, {
    details: { taskId },
  });
}

export class TaskService {
  readonly #tasks: TaskRepository;

  constructor(tasks: TaskRepository) {
    this.#tasks = tasks;
  }

  /**
   * Crea una tarea en una columna del tablero indicado.
   *
   * Con `position` explicita se inserta desplazando las siguientes; sin ella va
   * al final. En los dos casos la columna entera se reescribe dentro de la
   * transaccion, que es lo que garantiza que no queden huecos.
   */
  async create(input: CreateTaskInput): Promise<Task> {
    const detalle = { boardId: input.boardId, columnId: input.columnId };
    // El titulo se normaliza antes de abrir la transaccion: si esta mal, no
    // hace falta ni tocar la base.
    const title = normalizarTitulo(input.title, detalle);
    const position = input.position ?? "end";
    assertValidPosition(position, detalle);

    return this.#tasks.inTransaction(async (tx) => {
      const tablero = await tx.findBoard(input.boardId);
      if (tablero === undefined) {
        throw new DomainError("BOARD_NOT_FOUND", `No existe el tablero ${input.boardId}.`, {
          details: { boardId: input.boardId },
        });
      }

      const columna = await tx.findColumn(input.columnId);
      if (columna === undefined) {
        throw new DomainError("COLUMN_NOT_FOUND", `No existe la columna ${input.columnId}.`, {
          details: { columnId: input.columnId },
        });
      }
      if (columna.boardId !== input.boardId) {
        throw new DomainError(
          "COLUMN_NOT_IN_BOARD",
          `La columna ${input.columnId} pertenece a otro tablero.`,
          {
            details: { ...detalle, columnBoardId: columna.boardId },
            hint: "Una tarea solo puede crearse en una columna de su propio tablero.",
          },
        );
      }

      const existentes = ordenarPorPosicion(await tx.lockColumnTasks(input.columnId));
      // Una posicion mayor que el tamano de la columna se ajusta al final, igual
      // que en `move`: quien calcula mal el indice obtiene un resultado util.
      const indice = position === "end" ? existentes.length : Math.min(position, existentes.length);

      const id = randomUUID();
      const orden = [...existentes];
      orden.splice(indice, 0, id);

      await tx.insertTask({
        id,
        boardId: input.boardId,
        columnId: input.columnId,
        title,
        description: input.description ?? null,
        priority: input.priority ?? "MEDIUM",
        dueDate: input.dueDate ?? null,
        position: indice,
      });
      await tx.rewriteColumn(input.columnId, orden);

      const creada = await tx.readTask(id);
      if (creada === undefined) {
        throw tareaNoEncontrada(id);
      }
      return creada;
    });
  }

  async get(taskId: string): Promise<Task> {
    const tarea = await this.#tasks.findTask(taskId);
    if (tarea === undefined) {
      throw tareaNoEncontrada(taskId);
    }
    return tarea;
  }

  async list(query: ListTasksQuery = {}): Promise<Page<Task>> {
    return this.#tasks.listTasks(query);
  }

  async search(text: string, scope: SearchScope = {}): Promise<Page<TaskMatch>> {
    return this.#tasks.searchTasks(text, scope);
  }

  /**
   * Patch parcial. Solo los campos presentes se modifican; `position` y
   * `columnId` no son modificables aca y requieren `move`.
   *
   * Si el patch no produce cambio efectivo la operacion es exitosa y no
   * escribe: devuelve la tarea tal como estaba.
   */
  async update(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    return this.#tasks.inTransaction(async (tx) => {
      const actual = await tx.readTask(taskId);
      if (actual === undefined) {
        throw tareaNoEncontrada(taskId);
      }

      const siguiente: TaskFields = {
        title:
          patch.title === undefined ? actual.title : normalizarTitulo(patch.title, { taskId }),
        description: patch.description === undefined ? actual.description : patch.description,
        priority: patch.priority ?? actual.priority,
        dueDate: patch.dueDate === undefined ? actual.dueDate : patch.dueDate,
      };

      if (sinCambioEfectivo(actual, siguiente)) {
        return actual;
      }

      await tx.updateTaskFields(taskId, siguiente);

      const actualizada = await tx.readTask(taskId);
      if (actualizada === undefined) {
        throw tareaNoEncontrada(taskId);
      }
      return actualizada;
    });
  }

  /** Elimina la tarea y reindexa su columna en la misma transaccion. */
  async delete(taskId: string): Promise<void> {
    await this.#tasks.inTransaction(async (tx) => {
      // La columna se resuelve dentro de la sentencia que bloquea, igual que en
      // `move`: si la tarea no existe, no hay filas y no hay columna que tocar.
      const bloqueadas = await tx.lockColumnOfTask(taskId);
      const actual = bloqueadas.find((fila) => fila.id === taskId);
      if (actual === undefined) {
        throw tareaNoEncontrada(taskId);
      }

      await tx.deleteTask(taskId);
      await tx.rewriteColumn(
        actual.columnId,
        ordenarPorPosicion(bloqueadas.filter((fila) => fila.id !== taskId)),
      );
    });
  }

  /**
   * Mueve una tarea a una columna y posicion del mismo tablero.
   *
   * Todo ocurre en una transaccion REPEATABLE READ que reescribe la secuencia
   * completa 0..n-1 de cada columna afectada. Mover dentro de la misma columna
   * no es una rama aparte: es el mismo calculo con origen igual a destino.
   */
  async move(taskId: string, target: MoveTarget): Promise<MoveResult> {
    return this.#tasks.inTransaction(async (tx) => this.#move(tx, taskId, target));
  }

  async #move(tx: MoveTransaction, taskId: string, target: MoveTarget): Promise<MoveResult> {
    // Pasos 1 y 3 del algoritmo, en una sola sentencia y en orden canonico.
    // Ver el comentario de `lockTaskAndColumns`: separarlos reintroduce el
    // interbloqueo que el orden de bloqueo existe para evitar.
    const bloqueadas = await tx.lockTaskAndColumns(taskId, target.columnId);

    const actual = bloqueadas.find((fila) => fila.id === taskId);
    if (actual === undefined) {
      throw tareaNoEncontrada(taskId);
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
    assertValidPosition(target.position, { taskId });

    const ordenNuevo = computeMoveOrder({
      taskId,
      fromColumnId: actual.columnId,
      toColumnId: target.columnId,
      currentOrder: agruparPorColumna(bloqueadas),
      position: target.position,
    });

    // Paso 5: secuencia completa de cada columna afectada, nunca diferencias.
    for (const [columnId, taskOrder] of ordenNuevo) {
      await tx.rewriteColumn(columnId, taskOrder);
    }

    const tarea = await tx.readTask(taskId);
    if (tarea === undefined) {
      // Inalcanzable: la fila esta bloqueada por esta misma transaccion.
      throw tareaNoEncontrada(taskId);
    }

    // El orden que devolvemos se relee de la base, no se asume del calculo.
    const columnasAfectadas =
      actual.columnId === target.columnId ? [target.columnId] : [actual.columnId, target.columnId];

    const affectedColumns: ColumnOrder[] = [];
    for (const columnId of columnasAfectadas) {
      affectedColumns.push({ columnId, taskOrder: await tx.readColumnOrder(columnId) });
    }

    return {
      task: tarea,
      fromColumnId: actual.columnId,
      toColumnId: target.columnId,
      affectedColumns,
    };
  }
}
