import { randomUUID } from "node:crypto";

import type { BoardRepository, BoardTransaction, NewColumnRow } from "../db/board-repository.js";
import type { ActorContext } from "../domain/actor.js";
import {
  actualizacion,
  borrado,
  camposModificados,
  CAMPOS_TABLERO,
  creacion,
  tableroConColumnas,
} from "../domain/audit.js";
import { LIMITE_COLUMN_NAME, normalizarColumnKey } from "../domain/column-key.js";
import { DomainError } from "../domain/errors.js";
import { normalizarTexto } from "../domain/text.js";
import type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  CreateBoardInput,
  ListBoardsQuery,
  Page,
  UpdateBoardInput,
} from "../domain/types.js";
import { AuditService } from "./audit-service.js";

/** Iguales a los VARCHAR de `board`. */
export const LIMITE_BOARD_NAME = 120;
export const LIMITE_BOARD_DESCRIPTION = 2000;

/**
 * Las cuatro columnas de la 4.3, en este orden y con estas keys exactas.
 *
 * No son un detalle de presentacion: son el contrato con el que los agentes
 * resuelven referencias por nombre, asi que cambiarlas rompe integraciones.
 */
export const COLUMNAS_POR_DEFECTO: ReadonlyArray<{ key: string; name: string }> = [
  { key: "BACKLOG", name: "Backlog" },
  { key: "TODO", name: "Por hacer" },
  { key: "IN_PROGRESS", name: "En progreso" },
  { key: "DONE", name: "Completado" },
];

function normalizarNombre(nombre: string, maxLength: number, details: Record<string, unknown>): string {
  return normalizarTexto(
    nombre,
    { campo: "name", maxLength, vacio: "NAME_REQUIRED", largo: "NAME_TOO_LONG" },
    details,
  );
}

/** La descripcion puede estar vacia; solo tiene tope de longitud. */
function normalizarDescripcion(
  descripcion: string | null | undefined,
  details: Record<string, unknown>,
): string | null {
  if (descripcion === undefined || descripcion === null) {
    return null;
  }

  const recortada = descripcion.trim();
  if (recortada === "") {
    return null;
  }

  const caracteres = [...recortada].length;
  if (caracteres > LIMITE_BOARD_DESCRIPTION) {
    throw new DomainError(
      "DESCRIPTION_TOO_LONG",
      `La descripcion tiene ${caracteres} caracteres y el maximo es ${LIMITE_BOARD_DESCRIPTION}.`,
      {
        details: {
          ...details,
          field: "description",
          length: caracteres,
          maxLength: LIMITE_BOARD_DESCRIPTION,
        },
      },
    );
  }

  return recortada;
}

function tableroNoEncontrado(boardId: string): DomainError {
  return new DomainError("BOARD_NOT_FOUND", `No existe el tablero ${boardId}.`, {
    details: { boardId },
  });
}

export class BoardService {
  readonly #boards: BoardRepository;
  readonly #audit: AuditService;

  /**
   * `audit` es inyectable y tiene default porque solo hay una implementacion
   * real: el punto de la inyeccion no es elegir entre varias, es poder darle a
   * una prueba una que falle y comprobar que la operacion se revierte de
   * verdad, como pide el criterio de F3.
   */
  constructor(boards: BoardRepository, audit: AuditService = new AuditService()) {
    this.#boards = boards;
    this.#audit = audit;
  }

  /**
   * Crea un tablero con sus columnas. Sin `columns`, las cuatro de la 4.3.
   *
   * Tablero y columnas se crean en la misma transaccion: un tablero sin
   * columnas no es un estado util, y dejarlo a medias obligaria a todos los
   * llamadores a contemplarlo.
   */
  async create(input: CreateBoardInput, ctx: ActorContext): Promise<BoardDetail> {
    const name = normalizarNombre(input.name, LIMITE_BOARD_NAME, {});
    const description = normalizarDescripcion(input.description, {});

    const definiciones = (input.columns ?? COLUMNAS_POR_DEFECTO).map((columna, indice) => ({
      name: normalizarNombre(columna.name, LIMITE_COLUMN_NAME, { position: indice }),
      key: normalizarColumnKey(columna.key, { position: indice }),
    }));

    const keys = new Set<string>();
    for (const definicion of definiciones) {
      if (keys.has(definicion.key)) {
        throw new DomainError(
          "DUPLICATE_KEY",
          `La key ${definicion.key} aparece dos veces en el tablero.`,
          { details: { columnKey: definicion.key } },
        );
      }
      keys.add(definicion.key);
    }

    const boardId = randomUUID();
    const columnas: NewColumnRow[] = definiciones.map((definicion, indice) => ({
      id: randomUUID(),
      boardId,
      name: definicion.name,
      key: definicion.key,
      position: indice,
    }));

    return this.#boards.inTransaction(async (tx) => {
      await tx.insertBoard({ id: boardId, name, description });
      for (const columna of columnas) {
        await tx.insertColumn(columna);
      }

      const detalle = await this.#detalle(tx, boardId);
      // Dentro de la MISMA transaccion (7.4): si el registro falla, el tablero
      // y sus columnas se van con el.
      await this.#audit.registrar(tx, ctx, creacion("board", boardId, tableroConColumnas(detalle)));
      return detalle;
    });
  }

  async get(boardId: string): Promise<BoardDetail> {
    const tablero = await this.#boards.findBoard(boardId);
    if (tablero === undefined) {
      throw tableroNoEncontrado(boardId);
    }
    return { ...tablero, columns: await this.#boards.readBoardColumns(boardId) };
  }

  /**
   * El tablero con sus columnas y el recuento de tareas de cada una (6.2).
   *
   * Metodo aparte y no un parametro de `get`: los llamadores que ya existen no
   * necesitan el recuento, y pagarlo siempre seria una consulta de mas en el
   * camino que mas se usa —resolver una columna por key— por un dato que ahi
   * nadie mira.
   */
  async getWithTaskCounts(boardId: string): Promise<BoardWithTaskCounts> {
    const tablero = await this.get(boardId);
    const cuentas = await this.#boards.countTasksByColumn(boardId);

    const columns = tablero.columns.map((columna) => ({
      ...columna,
      // Una columna vacia no sale del GROUP BY: la ausencia es cero.
      taskCount: cuentas.get(columna.id) ?? 0,
    }));

    return {
      ...tablero,
      columns,
      // Se suma lo ya contado en vez de pedir un total aparte: dos consultas
      // distintas podrian ver estados distintos y devolver un total que no
      // cuadra con la suma de las columnas que se muestran al lado.
      taskCount: columns.reduce((total, columna) => total + columna.taskCount, 0),
    };
  }

  async list(query: ListBoardsQuery = {}): Promise<Page<Board>> {
    return this.#boards.listBoards(query);
  }

  /** Patch parcial. Sin cambio efectivo es exitoso y no escribe. */
  async update(boardId: string, patch: UpdateBoardInput, ctx: ActorContext): Promise<BoardDetail> {
    return this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findBoard(boardId);
      if (actual === undefined) {
        throw tableroNoEncontrado(boardId);
      }

      const name =
        patch.name === undefined
          ? actual.name
          : normalizarNombre(patch.name, LIMITE_BOARD_NAME, { boardId });
      const description =
        patch.description === undefined
          ? actual.description
          : normalizarDescripcion(patch.description, { boardId });

      // Un solo criterio de "cambio efectivo" para escribir y para auditar: la
      // 5.2 los ata ("si el patch no produce cambio efectivo... no genera
      // registro"), asi que tenerlos separados solo permitiria que se separen.
      const cambios = camposModificados(actual, { ...actual, name, description }, CAMPOS_TABLERO);
      if (cambios !== null) {
        await tx.updateBoardFields(boardId, { name, description });
        await this.#audit.registrar(tx, ctx, actualizacion("board", boardId, cambios));
      }

      return this.#detalle(tx, boardId);
    });
  }

  /**
   * Elimina el tablero con sus columnas y tareas.
   *
   * La cascada la hace la FK `ON DELETE CASCADE`, verificada en F1a (T4). El
   * servicio no la replica: hacerlo a mano abriria la posibilidad de que las
   * dos versiones se separen.
   */
  async delete(boardId: string, ctx: ActorContext): Promise<void> {
    await this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findBoard(boardId);
      if (actual === undefined) {
        throw tableroNoEncontrado(boardId);
      }

      // Se lee lo que se va a perder ANTES de borrarlo: despues del DELETE ya
      // no hay de donde sacarlo, y la 5.2 pide el recuento de las entidades
      // eliminadas en cascada.
      const columnas = await tx.readBoardColumns(boardId);
      const tareas = await tx.countTasksInBoard(boardId);

      await tx.deleteBoard(boardId);
      await this.#audit.registrar(
        tx,
        ctx,
        borrado("board", boardId, tableroConColumnas({ ...actual, columns: columnas }), {
          tasks: tareas,
        }),
      );
    });
  }

  async #detalle(tx: BoardTransaction, boardId: string): Promise<BoardDetail> {
    const tablero = await tx.findBoard(boardId);
    if (tablero === undefined) {
      throw tableroNoEncontrado(boardId);
    }
    return { ...tablero, columns: await tx.readBoardColumns(boardId) };
  }
}
