import { Prisma, type PrismaClient } from "@taskman/db";

import type { Priority, Task } from "../domain/types.js";
import { isSerializationFailure } from "./db-error.js";

/**
 * Unica capa del nucleo que ve Prisma. Todo lo de arriba trabaja contra
 * `MoveTransaction`, que no menciona ni Prisma ni SQL.
 */

/** Fila bloqueada con FOR UPDATE: lo minimo para recalcular un orden. */
export interface LockedTask {
  id: string;
  boardId: string;
  columnId: string;
  position: number;
}

export interface ColumnRef {
  id: string;
  boardId: string;
}

export interface MoveTransaction {
  /**
   * Resuelve la columna origen de la tarea y bloquea con FOR UPDATE todas las
   * filas de la columna origen y de la destino, EN UNA SOLA SENTENCIA y en
   * orden canonico `(column_id, id)`.
   *
   * Que sea una sola sentencia no es cosmetico. Bloquear antes la tarea por su
   * cuenta tomaria un lock fuera del orden canonico, y dos movimientos cruzados
   * A->B y B->A se interbloquearian: cada transaccion tendria ya una fila de la
   * columna que la otra necesita primero.
   *
   * El orden es por `id` y no por `position` a proposito: `position` cambia,
   * asi que dos transacciones con snapshots distintos podrian recorrer la misma
   * columna en ordenes distintos. `id` es estable.
   */
  lockTaskAndColumns(taskId: string, targetColumnId: string): Promise<LockedTask[]>;
  findColumn(columnId: string): Promise<ColumnRef | undefined>;
  /** Reescribe la secuencia completa 0..n-1 de la columna. */
  rewriteColumn(columnId: string, orderedTaskIds: readonly string[]): Promise<void>;
  readColumnOrder(columnId: string): Promise<string[]>;
  readTask(taskId: string): Promise<Task | undefined>;
}

interface FilaBloqueada {
  id: string;
  board_id: string;
  column_id: string;
  position: number;
}

function crearMoveTransaction(tx: Prisma.TransactionClient): MoveTransaction {
  return {
    async lockTaskAndColumns(taskId, targetColumnId) {
      // Los parametros UUID van casteados: el adapter los bindea como texto y
      // PostgreSQL no compara uuid = text (ver CLAUDE.md).
      const filas = await tx.$queryRaw<FilaBloqueada[]>`
        SELECT id, board_id, column_id, position
          FROM task
         WHERE column_id = ANY (
                 ARRAY(SELECT origen.column_id FROM task AS origen WHERE origen.id = ${taskId}::uuid)
                 || ARRAY[${targetColumnId}::uuid]
               )
         ORDER BY column_id, id
           FOR UPDATE
      `;

      return filas.map((fila) => ({
        id: fila.id,
        boardId: fila.board_id,
        columnId: fila.column_id,
        position: fila.position,
      }));
    },

    async findColumn(columnId) {
      const columna = await tx.column.findUnique({
        where: { id: columnId },
        select: { id: true, boardId: true },
      });
      return columna ?? undefined;
    },

    async rewriteColumn(columnId, orderedTaskIds) {
      if (orderedTaskIds.length === 0) {
        return;
      }

      // Una sola sentencia reescribe la columna entera. `updated_at` solo se
      // toca en las filas que de verdad cambian: reescribimos la secuencia
      // completa, pero no queremos ensuciar la marca de tiempo de tareas que
      // se quedaron donde estaban.
      await tx.$executeRaw`
        UPDATE task AS t
           SET column_id  = ${columnId}::uuid,
               position   = v.pos,
               updated_at = CASE
                              WHEN t.column_id IS DISTINCT FROM ${columnId}::uuid
                                OR t.position  IS DISTINCT FROM v.pos
                              THEN now()
                              ELSE t.updated_at
                            END
          FROM (
                SELECT elem::uuid AS id, (ord - 1)::int AS pos
                  FROM jsonb_array_elements_text(${JSON.stringify(orderedTaskIds)}::jsonb)
                       WITH ORDINALITY AS a(elem, ord)
               ) AS v
         WHERE t.id = v.id
      `;
    },

    async readColumnOrder(columnId) {
      const filas = await tx.task.findMany({
        where: { columnId },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      return filas.map((fila) => fila.id);
    },

    async readTask(taskId) {
      const tarea = await tx.task.findUnique({ where: { id: taskId } });
      if (tarea === null) {
        return undefined;
      }

      return {
        id: tarea.id,
        boardId: tarea.boardId,
        columnId: tarea.columnId,
        title: tarea.title,
        description: tarea.description,
        priority: tarea.priority as Priority,
        dueDate: tarea.dueDate,
        position: tarea.position,
        createdAt: tarea.createdAt,
        updatedAt: tarea.updatedAt,
      };
    },
  };
}

export class TaskRepository {
  readonly #prisma: PrismaClient;
  readonly #maxRetries: number;

  constructor(prisma: PrismaClient, options: { maxRetries?: number } = {}) {
    this.#prisma = prisma;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  /**
   * Corre `fn` en UNA transaccion interactiva con aislamiento REPEATABLE READ.
   *
   * En REPEATABLE READ, un FOR UPDATE sobre una fila que otra transaccion
   * modifico y commiteo despues de nuestro snapshot aborta con SQLSTATE 40001.
   * Eso no es un error del llamador: es la senal de reintentar con un snapshot
   * nuevo. Cualquier otro error, incluidos los de dominio, sube sin tocar.
   */
  async inMoveTransaction<T>(fn: (tx: MoveTransaction) => Promise<T>): Promise<T> {
    let ultimoFallo: unknown;

    for (let intento = 0; intento <= this.#maxRetries; intento += 1) {
      try {
        return await this.#prisma.$transaction(
          async (tx) => fn(crearMoveTransaction(tx)),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            timeout: 15_000,
            maxWait: 15_000,
          },
        );
      } catch (error: unknown) {
        if (!isSerializationFailure(error)) {
          throw error;
        }
        ultimoFallo = error;
      }
    }

    throw ultimoFallo;
  }
}
