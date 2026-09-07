import { randomUUID } from "node:crypto";

import type {
  LockedTask,
  MoveTransaction,
  TaskFields,
  TaskRepository,
} from "../db/task-repository.js";
import type { ActorContext } from "../domain/actor.js";
import {
  actualizacion,
  borrado,
  camposModificados,
  CAMPOS_TAREA,
  creacion,
  movimiento,
  tareaCompleta,
  ubicacion,
} from "../domain/audit.js";
import { DomainError } from "../domain/errors.js";
import { assertValidPosition, computeMoveOrder } from "../domain/order.js";
import { normalizarTitulo } from "../domain/title.js";
import { AuditService } from "./audit-service.js";
import { resolverColumna } from "./column-reference.js";
import type {
  ColumnOrder,
  CreateTaskInput,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  SearchScope,
  TargetPosition,
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

/**
 * La columna pertenece al tablero. Es una asercion con nombre y no un `if`
 * suelto porque es LA autoridad sobre la pertenencia.
 *
 * Importa cuando la columna se resolvio por `columnKey`: esa resolucion ocurre
 * fuera de la transaccion, en otro snapshot, y es una conveniencia para el
 * llamador, no una garantia. Entre la resolucion y el COMMIT la tarea pudo
 * cambiar de tablero. Lo que vale es lo que se lee bloqueado adentro, asi que
 * esta comprobacion se hace siempre, venga la columna de un id o de una key.
 *
 * NO es redundante con la FK compuesta `task_column_same_board`, aunque lo
 * parezca. Verificado sacandola: la FK igual protege el dato, pero el llamador
 * recibe un `23503` crudo de PostgreSQL. Esta asercion es lo que lo convierte
 * en COLUMN_NOT_IN_BOARD, que es un error que un agente puede accionar.
 */
function assertColumnaDelTablero(
  columna: { id: string; boardId: string },
  boardId: string,
  details: Readonly<Record<string, unknown>>,
): void {
  if (columna.boardId === boardId) {
    return;
  }

  throw new DomainError(
    "COLUMN_NOT_IN_BOARD",
    `La columna ${columna.id} pertenece a otro tablero.`,
    {
      details: { ...details, columnId: columna.id, columnBoardId: columna.boardId },
      hint: "Una tarea solo vive en columnas de su propio tablero.",
    },
  );
}

function tareaNoEncontrada(taskId: string): DomainError {
  return new DomainError("TASK_NOT_FOUND", `No existe la tarea ${taskId}.`, {
    details: { taskId },
  });
}

export class TaskService {
  readonly #tasks: TaskRepository;
  readonly #audit: AuditService;

  constructor(tasks: TaskRepository, audit: AuditService = new AuditService()) {
    this.#tasks = tasks;
    this.#audit = audit;
  }

  /**
   * Crea una tarea en una columna del tablero indicado.
   *
   * Con `position` explicita se inserta desplazando las siguientes; sin ella va
   * al final. En los dos casos la columna entera se reescribe dentro de la
   * transaccion, que es lo que garantiza que no queden huecos.
   */
  async create(input: CreateTaskInput, ctx: ActorContext): Promise<Task> {
    const detalle: Record<string, unknown> = {
      boardId: input.boardId,
      ...(input.columnId === undefined ? {} : { columnId: input.columnId }),
      ...(input.columnKey === undefined ? {} : { columnKey: input.columnKey }),
    };
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

      // Por id o por key, dentro del tablero. La resolucion vive en un solo
      // lugar; el ambito es siempre `input.boardId`, nunca global.
      const columna = await resolverColumna(tx, input.boardId, input);
      assertColumnaDelTablero(columna, input.boardId, detalle);

      const existentes = ordenarPorPosicion(await tx.lockColumnTasks(columna.id));
      // Una posicion mayor que el tamano de la columna se ajusta al final, igual
      // que en `move`: quien calcula mal el indice obtiene un resultado util.
      const indice = position === "end" ? existentes.length : Math.min(position, existentes.length);

      const id = randomUUID();
      const orden = [...existentes];
      orden.splice(indice, 0, id);

      await tx.insertTask({
        id,
        boardId: input.boardId,
        columnId: columna.id,
        title,
        description: input.description ?? null,
        priority: input.priority ?? "MEDIUM",
        dueDate: input.dueDate ?? null,
        position: indice,
      });
      await tx.rewriteColumn(columna.id, orden);

      const creada = await tx.readTask(id);
      if (creada === undefined) {
        throw tareaNoEncontrada(id);
      }

      await this.#audit.registrar(tx, ctx, creacion("task", id, tareaCompleta(creada)));
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
    return this.#tasks.listTasks(await this.#resolverFiltro(query));
  }

  /** Traduce `columnKey` a `columnId` antes de consultar. Sin transaccion: es
   * una lectura, y el filtro no tiene invariante que proteger. */
  async #resolverFiltro(query: ListTasksQuery): Promise<ListTasksQuery> {
    if (query.columnKey === undefined || query.columnId !== undefined) {
      return query;
    }

    if (query.boardId === undefined) {
      throw new DomainError(
        "COLUMN_NOT_FOUND",
        "Una columnKey solo se resuelve dentro de un tablero.",
        {
          details: { columnKey: query.columnKey },
          hint: "Indica boardId junto a columnKey, o filtra directamente por columnId.",
        },
      );
    }

    const columna = await resolverColumna(this.#tasks, query.boardId, query);
    return { ...query, columnId: columna.id };
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
  async update(taskId: string, patch: UpdateTaskInput, ctx: ActorContext): Promise<Task> {
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

      // El mismo diff decide las dos cosas que la 5.2 ata: si hay que escribir
      // y que registrar. Antes eran dos comparaciones distintas del mismo par
      // de valores, y nada impedia que se separaran.
      //
      // `due_date` se compara como fecha sola, que es como la guarda la base
      // (DATE): cambiarle solo la hora a un vencimiento no es un cambio.
      const cambios = camposModificados(actual, { ...actual, ...siguiente }, CAMPOS_TAREA);
      if (cambios === null) {
        return actual;
      }

      await tx.updateTaskFields(taskId, siguiente);
      await this.#audit.registrar(tx, ctx, actualizacion("task", taskId, cambios));

      const actualizada = await tx.readTask(taskId);
      if (actualizada === undefined) {
        throw tareaNoEncontrada(taskId);
      }
      return actualizada;
    });
  }

  /** Elimina la tarea y reindexa su columna en la misma transaccion. */
  async delete(taskId: string, ctx: ActorContext): Promise<void> {
    await this.#tasks.inTransaction(async (tx) => {
      // La columna se resuelve dentro de la sentencia que bloquea, igual que en
      // `move`: si la tarea no existe, no hay filas y no hay columna que tocar.
      const bloqueadas = await tx.lockColumnOfTask(taskId);
      const actual = bloqueadas.find((fila) => fila.id === taskId);
      if (actual === undefined) {
        throw tareaNoEncontrada(taskId);
      }

      // La fila bloqueada trae lo justo para reordenar (id, columna, position).
      // La auditoria necesita la tarea ENTERA —titulo, descripcion, prioridad,
      // vencimiento— porque despues del DELETE ya no hay de donde sacarla, y un
      // registro que no dice que se perdio no sirve para reconstruir nada.
      const entera = await tx.readTask(taskId);
      if (entera === undefined) {
        // Inalcanzable: la fila esta bloqueada por esta misma transaccion.
        throw tareaNoEncontrada(taskId);
      }

      await tx.deleteTask(taskId);
      await tx.rewriteColumn(
        actual.columnId,
        ordenarPorPosicion(bloqueadas.filter((fila) => fila.id !== taskId)),
      );

      await this.#audit.registrar(tx, ctx, borrado("task", taskId, tareaCompleta(entera)));
    });
  }

  /**
   * Mueve una tarea a una columna y posicion del mismo tablero.
   *
   * Todo ocurre en una transaccion REPEATABLE READ que reescribe la secuencia
   * completa 0..n-1 de cada columna afectada. Mover dentro de la misma columna
   * no es una rama aparte: es el mismo calculo con origen igual a destino.
   */
  async move(taskId: string, target: MoveTarget, ctx: ActorContext): Promise<MoveResult> {
    const toColumnId = await this.#resolverDestino(taskId, target);
    return this.#tasks.inTransaction(async (tx) =>
      this.#move(tx, taskId, toColumnId, target.position, ctx),
    );
  }

  /**
   * Resuelve la columna destino ANTES de abrir la transaccion, porque la
   * sentencia que bloquea recibe el `columnId` como parametro y no puede
   * esperar a resolverlo adentro.
   *
   * Con `columnId` no hay nada que resolver y no se lee nada. Con `columnKey`
   * hace falta el tablero de la tarea, asi que se la lee por id SIN bloqueo:
   * leer no toma locks, asi que esto no reintroduce la inversion de orden de
   * F1b.1. El resultado es orientativo; la autoridad es
   * `assertColumnaDelTablero` dentro de la transaccion.
   */
  async #resolverDestino(taskId: string, target: MoveTarget): Promise<string> {
    if (target.columnId !== undefined) {
      return target.columnId;
    }

    const tarea = await this.#tasks.findTask(taskId);
    if (tarea === undefined) {
      throw tareaNoEncontrada(taskId);
    }

    const columna = await resolverColumna(this.#tasks, tarea.boardId, target);
    return columna.id;
  }

  async #move(
    tx: MoveTransaction,
    taskId: string,
    toColumnId: string,
    position: TargetPosition,
    ctx: ActorContext,
  ): Promise<MoveResult> {
    // Pasos 1 y 3 del algoritmo, en una sola sentencia y en orden canonico.
    // Ver el comentario de `lockTaskAndColumns`: separarlos reintroduce el
    // interbloqueo que el orden de bloqueo existe para evitar.
    const bloqueadas = await tx.lockTaskAndColumns(taskId, toColumnId);

    const actual = bloqueadas.find((fila) => fila.id === taskId);
    if (actual === undefined) {
      throw tareaNoEncontrada(taskId);
    }

    // Paso 2. La FK compuesta ya impide cruzar tableros, pero un error de
    // dominio explicito le dice al llamador que hizo mal.
    const destino = await tx.findColumn(toColumnId);
    if (destino === undefined) {
      throw new DomainError("COLUMN_NOT_FOUND", `No existe la columna ${toColumnId}.`, {
        details: { columnId: toColumnId },
      });
    }
    // Autoridad sobre cualquier resolucion previa de `columnKey`: el tablero
    // de la tarea es el que se leyo bloqueado aca, no el del snapshot anterior.
    assertColumnaDelTablero(destino, actual.boardId, { taskId, taskBoardId: actual.boardId });

    // Paso 4.
    assertValidPosition(position, { taskId });

    const ordenNuevo = computeMoveOrder({
      taskId,
      fromColumnId: actual.columnId,
      toColumnId: toColumnId,
      currentOrder: agruparPorColumna(bloqueadas),
      position: position,
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

    // MOVE se registra siempre, tambien cuando la tarea termina donde estaba:
    // a diferencia de un patch sin efecto (5.2), aca la operacion SI corrio y
    // reescribio el orden de la columna. `{ column_id, position }` en las dos
    // puntas es exactamente lo que pide la 7.4.
    await this.#audit.registrar(tx, ctx, movimiento(taskId, ubicacion(actual), ubicacion(tarea)));

    // El orden que devolvemos se relee de la base, no se asume del calculo.
    const columnasAfectadas =
      actual.columnId === toColumnId ? [toColumnId] : [actual.columnId, toColumnId];

    const affectedColumns: ColumnOrder[] = [];
    for (const columnId of columnasAfectadas) {
      affectedColumns.push({ columnId, taskOrder: await tx.readColumnOrder(columnId) });
    }

    return {
      task: tarea,
      fromColumnId: actual.columnId,
      toColumnId: toColumnId,
      affectedColumns,
    };
  }
}
