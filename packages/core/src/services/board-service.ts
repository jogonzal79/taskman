import { randomUUID } from "node:crypto";

import type { BoardRepository, BoardTransaction, NewColumnRow } from "../db/board-repository.js";
import { LIMITE_COLUMN_NAME, normalizarColumnKey } from "../domain/column-key.js";
import { DomainError } from "../domain/errors.js";
import { normalizarTexto } from "../domain/text.js";
import type {
  Board,
  BoardDetail,
  CreateBoardInput,
  ListBoardsQuery,
  Page,
  UpdateBoardInput,
} from "../domain/types.js";

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

  constructor(boards: BoardRepository) {
    this.#boards = boards;
  }

  /**
   * Crea un tablero con sus columnas. Sin `columns`, las cuatro de la 4.3.
   *
   * Tablero y columnas se crean en la misma transaccion: un tablero sin
   * columnas no es un estado util, y dejarlo a medias obligaria a todos los
   * llamadores a contemplarlo.
   */
  async create(input: CreateBoardInput): Promise<BoardDetail> {
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
      return this.#detalle(tx, boardId);
    });
  }

  async get(boardId: string): Promise<BoardDetail> {
    const tablero = await this.#boards.findBoard(boardId);
    if (tablero === undefined) {
      throw tableroNoEncontrado(boardId);
    }
    return { ...tablero, columns: await this.#boards.readBoardColumns(boardId) };
  }

  async list(query: ListBoardsQuery = {}): Promise<Page<Board>> {
    return this.#boards.listBoards(query);
  }

  /** Patch parcial. Sin cambio efectivo es exitoso y no escribe. */
  async update(boardId: string, patch: UpdateBoardInput): Promise<BoardDetail> {
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

      if (name !== actual.name || description !== actual.description) {
        await tx.updateBoardFields(boardId, { name, description });
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
  async delete(boardId: string): Promise<void> {
    await this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findBoard(boardId);
      if (actual === undefined) {
        throw tableroNoEncontrado(boardId);
      }
      await tx.deleteBoard(boardId);
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
