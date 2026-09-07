import { Prisma, type PrismaClient } from "@taskman/db";

import type {
  ListTasksQuery,
  Priority,
  SearchScope,
  Task,
  TaskMatch,
  TaskOrderBy,
} from "../domain/types.js";
import type { OrdenSql } from "./pagination.js";
import { clausulaOrden, condicionCursor, decodificarCursor, normalizarLimite, paginar } from "./pagination.js";
import type { TransactionRunner } from "./transaction-runner.js";

/**
 * Unica capa del nucleo que ve Prisma. Todo lo de arriba trabaja contra
 * `TaskTransaction` y los metodos de lectura del repositorio, que no mencionan
 * ni Prisma ni SQL.
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

export interface NewTaskRow {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: Priority;
  dueDate: Date | null;
  position: number;
}

/** Campos que `update` puede tocar. `position` y `columnId` no estan: son `move`. */
export interface TaskFields {
  title: string;
  description: string | null;
  priority: Priority;
  dueDate: Date | null;
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

export interface TaskTransaction extends MoveTransaction {
  /** Bloquea las filas de una columna. Para `create`, que todavia no tiene tarea. */
  lockColumnTasks(columnId: string): Promise<LockedTask[]>;
  /**
   * Bloquea las filas de la columna que contiene la tarea, resolviendola por
   * subquery en la misma sentencia. Devuelve vacio si la tarea no existe, que
   * es como `delete` detecta TASK_NOT_FOUND sin una lectura previa sin bloqueo.
   */
  lockColumnOfTask(taskId: string): Promise<LockedTask[]>;
  findColumnByKey(boardId: string, key: string): Promise<ColumnRef | undefined>;
  findBoard(boardId: string): Promise<{ id: string } | undefined>;
  insertTask(row: NewTaskRow): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  updateTaskFields(taskId: string, fields: TaskFields): Promise<void>;
}

interface FilaBloqueada {
  id: string;
  board_id: string;
  column_id: string;
  position: number;
}

function aLockedTask(fila: FilaBloqueada): LockedTask {
  return {
    id: fila.id,
    boardId: fila.board_id,
    columnId: fila.column_id,
    position: fila.position,
  };
}

function aTask(fila: {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): Task {
  return {
    id: fila.id,
    boardId: fila.boardId,
    columnId: fila.columnId,
    title: fila.title,
    description: fila.description,
    priority: fila.priority as Priority,
    dueDate: fila.dueDate,
    position: fila.position,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  };
}

/**
 * Bloquea con FOR UPDATE las filas de tarea de varias columnas, en orden
 * canonico `(column_id, id)`. Lo usa `move` y tambien el reassignTo de
 * ColumnService: si dos operaciones bloquearan estas filas en ordenes
 * distintos volveria el interbloqueo que el orden canonico existe para evitar.
 */
export async function lockTasksOfColumns(
  tx: Prisma.TransactionClient,
  columnIds: readonly string[],
): Promise<LockedTask[]> {
  if (columnIds.length === 0) {
    return [];
  }

  const filas = await tx.$queryRaw<FilaBloqueada[]>`
    SELECT id, board_id, column_id, position
      FROM task
     WHERE column_id = ANY (ARRAY(
             SELECT elem::uuid
               FROM jsonb_array_elements_text(${JSON.stringify(columnIds)}::jsonb) AS a(elem)
           ))
     ORDER BY column_id, id
       FOR UPDATE
  `;
  return filas.map(aLockedTask);
}

/** Reescribe la secuencia completa 0..n-1 de tareas de una columna. */
export async function rewriteTaskPositions(
  tx: Prisma.TransactionClient,
  columnId: string,
  orderedTaskIds: readonly string[],
): Promise<void> {
  if (orderedTaskIds.length === 0) {
    return;
  }

  // Una sola sentencia reescribe la columna entera. `updated_at` solo se toca
  // en las filas que de verdad cambian: reescribimos la secuencia completa,
  // pero no queremos ensuciar la marca de tiempo de tareas que se quedaron
  // donde estaban.
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
}

function crearTaskTransaction(tx: Prisma.TransactionClient): TaskTransaction {
  // Los parametros UUID van casteados en todo el SQL crudo: el adapter los
  // bindea como texto y PostgreSQL no compara uuid = text (ver CLAUDE.md).
  return {
    async lockTaskAndColumns(taskId, targetColumnId) {
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
      return filas.map(aLockedTask);
    },

    async lockColumnTasks(columnId) {
      const filas = await tx.$queryRaw<FilaBloqueada[]>`
        SELECT id, board_id, column_id, position
          FROM task
         WHERE column_id = ${columnId}::uuid
         ORDER BY column_id, id
           FOR UPDATE
      `;
      return filas.map(aLockedTask);
    },

    async lockColumnOfTask(taskId) {
      const filas = await tx.$queryRaw<FilaBloqueada[]>`
        SELECT id, board_id, column_id, position
          FROM task
         WHERE column_id = ANY (
                 ARRAY(SELECT origen.column_id FROM task AS origen WHERE origen.id = ${taskId}::uuid)
               )
         ORDER BY column_id, id
           FOR UPDATE
      `;
      return filas.map(aLockedTask);
    },

    async findColumn(columnId) {
      const columna = await tx.column.findUnique({
        where: { id: columnId },
        select: { id: true, boardId: true },
      });
      return columna ?? undefined;
    },

    async findColumnByKey(boardId, key) {
      const columna = await tx.column.findUnique({
        where: { boardId_key: { boardId, key } },
        select: { id: true, boardId: true },
      });
      return columna ?? undefined;
    },

    async findBoard(boardId) {
      const tablero = await tx.board.findUnique({ where: { id: boardId }, select: { id: true } });
      return tablero ?? undefined;
    },

    async insertTask(row) {
      await tx.task.create({
        data: {
          id: row.id,
          boardId: row.boardId,
          columnId: row.columnId,
          title: row.title,
          description: row.description,
          priority: row.priority,
          dueDate: row.dueDate,
          position: row.position,
        },
      });
    },

    async deleteTask(taskId) {
      await tx.task.delete({ where: { id: taskId } });
    },

    async updateTaskFields(taskId, fields) {
      await tx.task.update({
        where: { id: taskId },
        data: {
          title: fields.title,
          description: fields.description,
          priority: fields.priority,
          dueDate: fields.dueDate,
        },
      });
    },

    async rewriteColumn(columnId, orderedTaskIds) {
      await rewriteTaskPositions(tx, columnId, orderedTaskIds);
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
      return tarea === null ? undefined : aTask(tarea);
    },
  };
}

// --- Listado y busqueda ------------------------------------------------------
//
// Van en dos pasos a proposito: SQL crudo resuelve el orden y el cursor, y la
// hidratacion de las filas pasa por el API de modelos. Asi el `Task` que sale
// de `list` es identico al que sale de `get`, sin depender de como el driver
// mapea DATE, timestamptz o el enum en una consulta cruda.

const ORDEN: Record<TaskOrderBy, OrdenSql> = {
  position: { columna: "position", direccion: "ASC", admiteNulos: false, cast: "::int" },
  dueDate: { columna: "due_date", direccion: "ASC", admiteNulos: true, cast: "::date" },
  priority: { columna: "priority", direccion: "DESC", admiteNulos: false, cast: '::"Priority"' },
  createdAt: {
    columna: "created_at",
    direccion: "DESC",
    admiteNulos: false,
    cast: "::timestamptz",
  },
};

export class TaskRepository {
  readonly #runner: TransactionRunner;

  constructor(runner: TransactionRunner) {
    this.#runner = runner;
  }

  get #prisma(): PrismaClient {
    return this.#runner.prisma;
  }

  /** Ver `TransactionRunner`: REPEATABLE READ y reintentos ante contencion. */
  async inTransaction<T>(fn: (tx: TaskTransaction) => Promise<T>): Promise<T> {
    return this.#runner.run(async (tx) => fn(crearTaskTransaction(tx)));
  }

  /** Lectura suelta: `get` no necesita transaccion. */
  async findTask(taskId: string): Promise<Task | undefined> {
    const tarea = await this.#prisma.task.findUnique({ where: { id: taskId } });
    return tarea === null ? undefined : aTask(tarea);
  }

  // Con estas dos, el repositorio cumple `BuscadorDeColumnas` y sirve para
  // resolver una columnKey fuera de transaccion.
  async findColumn(columnId: string): Promise<ColumnRef | undefined> {
    const columna = await this.#prisma.column.findUnique({
      where: { id: columnId },
      select: { id: true, boardId: true },
    });
    return columna ?? undefined;
  }

  async findColumnByKey(boardId: string, key: string): Promise<ColumnRef | undefined> {
    const columna = await this.#prisma.column.findUnique({
      where: { boardId_key: { boardId, key } },
      select: { id: true, boardId: true },
    });
    return columna ?? undefined;
  }

  /** Hidrata por id respetando el orden recibido. */
  async #hidratar(ids: readonly string[]): Promise<Task[]> {
    if (ids.length === 0) {
      return [];
    }

    const filas = await this.#prisma.task.findMany({ where: { id: { in: [...ids] } } });
    const porId = new Map(filas.map((fila) => [fila.id, aTask(fila)]));
    return ids.flatMap((id) => {
      const tarea = porId.get(id);
      return tarea === undefined ? [] : [tarea];
    });
  }

  async listTasks(query: ListTasksQuery): Promise<{ items: Task[]; nextCursor: string | null }> {
    const orden = ORDEN[query.orderBy ?? "position"];
    const limite = normalizarLimite(query.limit);
    const condiciones: Prisma.Sql[] = [];

    if (query.boardId !== undefined) {
      condiciones.push(Prisma.sql`board_id = ${query.boardId}::uuid`);
    }
    if (query.columnId !== undefined) {
      condiciones.push(Prisma.sql`column_id = ${query.columnId}::uuid`);
    }
    if (query.priority !== undefined && query.priority.length > 0) {
      const valores = query.priority.map((p) => Prisma.sql`${p}::"Priority"`);
      condiciones.push(Prisma.sql`priority IN (${Prisma.join(valores, ", ")})`);
    }
    if (query.dueBefore !== undefined) {
      condiciones.push(Prisma.sql`due_date < ${query.dueBefore}::date`);
    }
    if (query.dueAfter !== undefined) {
      condiciones.push(Prisma.sql`due_date > ${query.dueAfter}::date`);
    }
    if (query.overdue === true) {
      // Vencida: con fecha pasada y fuera de la columna terminal.
      condiciones.push(Prisma.sql`due_date < CURRENT_DATE`);
      condiciones.push(
        Prisma.sql`column_id IN (SELECT id FROM board_column WHERE upper(key) <> 'DONE')`,
      );
    }

    const cursor = query.cursor === undefined ? undefined : decodificarCursor(query.cursor);
    if (cursor !== undefined) {
      condiciones.push(condicionCursor(orden, cursor));
    }

    const where =
      condiciones.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(condiciones, " AND ")}`;
    const orderBy = clausulaOrden(orden);
    const columnaOrden = Prisma.raw(orden.columna);

    // Se pide una fila de mas para saber si hay pagina siguiente.
    const filas = await this.#prisma.$queryRaw<Array<{ id: string; orden: string | null }>>`
      SELECT id, ${columnaOrden}::text AS orden
        FROM task
        ${where}
       ORDER BY ${orderBy}
       LIMIT ${limite + 1}
    `;

    return paginar(filas, limite, (ids) => this.#hidratar(ids));
  }

  async searchTasks(
    texto: string,
    scope: SearchScope,
  ): Promise<{ items: TaskMatch[]; nextCursor: string | null }> {
    const limite = normalizarLimite(scope.limit);

    // Misma expresion que el indice GIN de la migracion, para que lo use.
    const documento = Prisma.sql`to_tsvector('spanish', title || ' ' || coalesce(description, ''))`;
    const consulta = Prisma.sql`plainto_tsquery('spanish', ${texto})`;

    const condiciones: Prisma.Sql[] = [Prisma.sql`${documento} @@ ${consulta}`];
    if (scope.boardId !== undefined) {
      condiciones.push(Prisma.sql`board_id = ${scope.boardId}::uuid`);
    }
    if (scope.columnId !== undefined) {
      condiciones.push(Prisma.sql`column_id = ${scope.columnId}::uuid`);
    }

    const cursor = scope.cursor === undefined ? undefined : decodificarCursor(scope.cursor);
    if (cursor !== undefined && cursor.v !== null) {
      condiciones.push(Prisma.sql`(
        ts_rank(${documento}, ${consulta}) < ${cursor.v}::real
        OR (ts_rank(${documento}, ${consulta}) = ${cursor.v}::real AND id > ${cursor.id}::uuid)
      )`);
    }

    const filas = await this.#prisma.$queryRaw<Array<{ id: string; orden: string | null }>>`
      SELECT id, ts_rank(${documento}, ${consulta})::text AS orden
        FROM task
       WHERE ${Prisma.join(condiciones, " AND ")}
       ORDER BY ts_rank(${documento}, ${consulta}) DESC, id ASC
       LIMIT ${limite + 1}
    `;

    const pagina = await paginar(filas, limite, (ids) => this.#hidratar(ids));
    const rangos = new Map(filas.map((fila) => [fila.id, Number(fila.orden ?? "0")]));

    return {
      items: pagina.items.map((task) => ({ task, rank: rangos.get(task.id) ?? 0 })),
      nextCursor: pagina.nextCursor,
    };
  }
}
