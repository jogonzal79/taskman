import { Prisma, type PrismaClient } from "@taskman/db";

import type { Board, Column, ListBoardsQuery } from "../domain/types";
import type { AuditRow, AuditTransaction } from "./audit-repository";
import { insertAuditRow } from "./audit-repository";
import type { EscrituraIdempotente, IdempotencyRow } from "./idempotency-repository";
import { insertIdempotencyRow } from "./idempotency-repository";
import type { OrdenSql } from "./pagination";
import { clausulaOrden, condicionCursor, decodificarCursor, normalizarLimite, paginar } from "./pagination";
import type { LockedTask } from "./task-repository";
import { lockTasksOfColumns, rewriteTaskPositions } from "./task-repository";
import type { TransactionRunner } from "./transaction-runner";

/** Fila de columna bloqueada: lo minimo para recalcular el orden del tablero. */
export interface LockedColumn {
  id: string;
  boardId: string;
  position: number;
}

export interface NewBoardRow {
  id: string;
  name: string;
  description: string | null;
}

export interface NewColumnRow {
  id: string;
  boardId: string;
  name: string;
  key: string;
  position: number;
}

/**
 * Extiende `AuditTransaction` a proposito: el registro de auditoria de una
 * operacion sobre tableros o columnas se escribe con ESTA transaccion (7.4).
 *
 * Y `EscrituraIdempotente` por lo mismo, para la 6.5: el registro de
 * idempotencia se guarda con ESTA transaccion o no se guarda. La diferencia
 * entre las dos es quien las llama: `insertAudit` lo llama el nucleo a traves de
 * `AuditService`, e `insertIdempotency` lo llama un participante externo, que
 * por eso recibe SOLO esa interfaz y nunca esta.
 */
export interface BoardTransaction extends AuditTransaction, EscrituraIdempotente {
  findBoard(boardId: string): Promise<Board | undefined>;
  insertBoard(row: NewBoardRow): Promise<void>;
  updateBoardFields(
    boardId: string,
    fields: { name: string; description: string | null },
  ): Promise<void>;
  /** La cascada la hace la FK; ver la prueba T4 de F1a. */
  deleteBoard(boardId: string): Promise<void>;

  /**
   * Bloquea las filas de columna del tablero en orden canonico `(board_id, id)`.
   *
   * Es FOR NO KEY UPDATE, no FOR UPDATE, y la diferencia importa: insertar o
   * mover una tarea toma FOR KEY SHARE sobre la fila de su columna al validar
   * la FK. FOR UPDATE choca con ese modo, asi que una operacion de columnas que
   * lo tomara y despues esperara filas de tarea se interbloquearia con un move
   * que ya tiene esas filas y necesita el chequeo de FK. FOR NO KEY UPDATE no
   * choca con FOR KEY SHARE y sigue serializando las operaciones de columnas
   * entre si, que es lo unico que necesitamos.
   */
  lockBoardColumns(boardId: string): Promise<LockedColumn[]>;
  findColumn(columnId: string): Promise<Column | undefined>;
  findColumnByKey(boardId: string, key: string): Promise<Column | undefined>;
  insertColumn(row: NewColumnRow): Promise<void>;
  updateColumnName(columnId: string, name: string): Promise<void>;
  deleteColumn(columnId: string): Promise<void>;
  /** Reescribe la secuencia completa 0..n-1 de columnas del tablero. */
  rewriteBoardColumns(boardId: string, orderedColumnIds: readonly string[]): Promise<void>;
  readBoardColumns(boardId: string): Promise<Column[]>;
  countTasksInColumn(columnId: string): Promise<number>;

  /**
   * Los ids de las tareas del tablero, BLOQUEADAS, en orden canonico
   * `(column_id, id)`. La 5.2 pide registrar el RECUENTO de lo que se lleva la
   * cascada, no los ids; los ids van ademas, con la forma `{ count, entity_ids }`
   * que la 7.4 le da a BULK_DELETE, para saber QUE tareas se perdieron.
   *
   * El FOR UPDATE no sobra, y es lo unico que hace exacta la lista. Una lectura
   * sin bloqueo se resuelve en el snapshot de REPEATABLE READ, y ese snapshot
   * puede incluir una tarea que otra transaccion ya borro y commiteo: la
   * cascada no la encuentra —para ella no existe— asi que no hay con que
   * chocar, el borrado commitea y el registro nombra una tarea que sobrevivio.
   * MEDIDO: leyendo sin bloqueo, un delete_task concurrente deja 3 ids
   * registrados contra 2 tareas borradas de verdad; con FOR UPDATE ese mismo
   * entrelazado da 40001, el runner reintenta y quedan 2 y 2.
   *
   * El otro lado —una tarea CREADA despues del snapshot— ya lo cerraba la
   * cascada sola: el trigger de la FK la ve con el snapshot mas reciente,
   * falla el crosscheck contra el de la transaccion y aborta con 40001.
   *
   * El orden es el canonico de la 5.4, el mismo de `lockColumnTasks` y
   * `lockTasksOfColumns`, y NO es para la salida: quien registra los ids los
   * ordena por id, que es un orden total que sobrevive a las columnas.
   */
  lockBoardTaskIds(boardId: string): Promise<string[]>;

  // Para el reassignTo de `ColumnService.delete`, que mueve tareas entre
  // columnas dentro de la misma transaccion que borra la columna.
  lockTasksOfColumns(columnIds: readonly string[]): Promise<LockedTask[]>;
  rewriteTaskColumn(columnId: string, orderedTaskIds: readonly string[]): Promise<void>;
}

interface FilaColumnaBloqueada {
  id: string;
  board_id: string;
  position: number;
}

function aBoard(fila: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Board {
  return {
    id: fila.id,
    name: fila.name,
    description: fila.description,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  };
}

function aColumn(fila: {
  id: string;
  boardId: string;
  name: string;
  key: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}): Column {
  return {
    id: fila.id,
    boardId: fila.boardId,
    name: fila.name,
    key: fila.key,
    position: fila.position,
    createdAt: fila.createdAt,
    updatedAt: fila.updatedAt,
  };
}

function crearBoardTransaction(tx: Prisma.TransactionClient): BoardTransaction {
  return {
    async findBoard(boardId) {
      const tablero = await tx.board.findUnique({ where: { id: boardId } });
      return tablero === null ? undefined : aBoard(tablero);
    },

    async insertBoard(row) {
      await tx.board.create({
        data: { id: row.id, name: row.name, description: row.description },
      });
    },

    async updateBoardFields(boardId, fields) {
      await tx.board.update({
        where: { id: boardId },
        data: { name: fields.name, description: fields.description },
      });
    },

    async deleteBoard(boardId) {
      await tx.board.delete({ where: { id: boardId } });
    },

    async lockBoardColumns(boardId) {
      const filas = await tx.$queryRaw<FilaColumnaBloqueada[]>`
        SELECT id, board_id, position
          FROM board_column
         WHERE board_id = ${boardId}::uuid
         ORDER BY board_id, id
           FOR NO KEY UPDATE
      `;
      return filas.map((fila) => ({
        id: fila.id,
        boardId: fila.board_id,
        position: fila.position,
      }));
    },

    async findColumn(columnId) {
      const columna = await tx.column.findUnique({ where: { id: columnId } });
      return columna === null ? undefined : aColumn(columna);
    },

    async findColumnByKey(boardId, key) {
      const columna = await tx.column.findUnique({
        where: { boardId_key: { boardId, key } },
      });
      return columna === null ? undefined : aColumn(columna);
    },

    async insertColumn(row) {
      await tx.column.create({
        data: {
          id: row.id,
          boardId: row.boardId,
          name: row.name,
          key: row.key,
          position: row.position,
        },
      });
    },

    async updateColumnName(columnId, name) {
      await tx.column.update({ where: { id: columnId }, data: { name } });
    },

    async deleteColumn(columnId) {
      await tx.column.delete({ where: { id: columnId } });
    },

    async rewriteBoardColumns(boardId, orderedColumnIds) {
      if (orderedColumnIds.length === 0) {
        return;
      }

      // Mismo criterio que el orden de tareas: se reescribe la secuencia
      // entera, y `updated_at` solo se toca donde la position cambia de verdad.
      await tx.$executeRaw`
        UPDATE board_column AS c
           SET position   = v.pos,
               updated_at = CASE
                              WHEN c.position IS DISTINCT FROM v.pos
                              THEN now()
                              ELSE c.updated_at
                            END
          FROM (
                SELECT elem::uuid AS id, (ord - 1)::int AS pos
                  FROM jsonb_array_elements_text(${JSON.stringify(orderedColumnIds)}::jsonb)
                       WITH ORDINALITY AS a(elem, ord)
               ) AS v
         WHERE c.id = v.id AND c.board_id = ${boardId}::uuid
      `;
    },

    async readBoardColumns(boardId) {
      const filas = await tx.column.findMany({
        where: { boardId },
        orderBy: { position: "asc" },
      });
      return filas.map(aColumn);
    },

    async countTasksInColumn(columnId) {
      return tx.task.count({ where: { columnId } });
    },

    // El parametro UUID va casteado, como en todo el SQL crudo del proyecto: el
    // adapter lo bindea como texto y PostgreSQL no compara uuid = text.
    async lockBoardTaskIds(boardId) {
      const filas = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
          FROM task
         WHERE board_id = ${boardId}::uuid
         ORDER BY column_id, id
           FOR UPDATE
      `;
      return filas.map((fila) => fila.id);
    },

    async lockTasksOfColumns(columnIds) {
      return lockTasksOfColumns(tx, columnIds);
    },

    async rewriteTaskColumn(columnId, orderedTaskIds) {
      await rewriteTaskPositions(tx, columnId, orderedTaskIds);
    },

    async insertAudit(row: AuditRow) {
      await insertAuditRow(tx, row);
    },

    async insertIdempotency(row: IdempotencyRow) {
      await insertIdempotencyRow(tx, row);
    },
  };
}

/** Los tableros se listan por nombre; `id` hace total el orden para el cursor. */
const ORDEN_BOARD: OrdenSql = {
  columna: "name",
  direccion: "ASC",
  admiteNulos: false,
  cast: "::text",
};

export class BoardRepository {
  readonly #runner: TransactionRunner;

  constructor(runner: TransactionRunner) {
    this.#runner = runner;
  }

  get #prisma(): PrismaClient {
    return this.#runner.prisma;
  }

  /** Ver `TransactionRunner`: REPEATABLE READ y reintentos ante contencion. */
  async inTransaction<T>(fn: (tx: BoardTransaction) => Promise<T>): Promise<T> {
    return this.#runner.run(async (tx) => fn(crearBoardTransaction(tx)));
  }

  async findBoard(boardId: string): Promise<Board | undefined> {
    const tablero = await this.#prisma.board.findUnique({ where: { id: boardId } });
    return tablero === null ? undefined : aBoard(tablero);
  }

  async findColumn(columnId: string): Promise<Column | undefined> {
    const columna = await this.#prisma.column.findUnique({ where: { id: columnId } });
    return columna === null ? undefined : aColumn(columna);
  }

  async readBoardColumns(boardId: string): Promise<Column[]> {
    const filas = await this.#prisma.column.findMany({
      where: { boardId },
      orderBy: { position: "asc" },
    });
    return filas.map(aColumn);
  }

  /**
   * Cuantas tareas tiene cada columna del tablero, en UNA sola consulta.
   *
   * Con GROUP BY y no cargando las tareas para contarlas en memoria, que es lo
   * que hace hoy la herramienta MCP get_board: para el recuento no hace falta
   * traer ni una fila de `task`, y traerlas convierte una agregacion de coste
   * fijo en una transferencia proporcional al tamaño del tablero.
   *
   * Las columnas sin tareas NO aparecen en el resultado: un GROUP BY no inventa
   * grupos vacios. Quien lo consuma tiene que resolver la ausencia como cero,
   * y por eso devuelve un Map y no un array: el .get() ?? 0 es explicito.
   */
  async countTasksByColumn(boardId: string): Promise<Map<string, number>> {
    const filas = await this.#prisma.task.groupBy({
      by: ["columnId"],
      where: { boardId },
      _count: { _all: true },
    });

    return new Map(filas.map((fila) => [fila.columnId, fila._count._all]));
  }

  async listBoards(query: ListBoardsQuery): Promise<{ items: Board[]; nextCursor: string | null }> {
    const limite = normalizarLimite(query.limit);
    const cursor = query.cursor === undefined ? undefined : decodificarCursor(query.cursor);
    const where =
      cursor === undefined ? Prisma.empty : Prisma.sql`WHERE ${condicionCursor(ORDEN_BOARD, cursor)}`;

    // Se pide una fila de mas para saber si hay pagina siguiente.
    const filas = await this.#prisma.$queryRaw<Array<{ id: string; orden: string | null }>>`
      SELECT id, name::text AS orden
        FROM board
        ${where}
       ORDER BY ${clausulaOrden(ORDEN_BOARD)}
       LIMIT ${limite + 1}
    `;

    return paginar(filas, limite, (ids) => this.#hidratar(ids));
  }

  async #hidratar(ids: readonly string[]): Promise<Board[]> {
    if (ids.length === 0) {
      return [];
    }

    const filas = await this.#prisma.board.findMany({ where: { id: { in: [...ids] } } });
    const porId = new Map(filas.map((fila) => [fila.id, aBoard(fila)]));
    return ids.flatMap((id) => {
      const tablero = porId.get(id);
      return tablero === undefined ? [] : [tablero];
    });
  }
}
