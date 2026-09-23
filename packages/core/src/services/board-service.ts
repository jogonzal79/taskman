import { randomUUID } from "node:crypto";

import type { BoardRepository, BoardTransaction, NewColumnRow } from "../db/board-repository";
import type { ActorContext } from "../domain/actor";
import {
  actualizacion,
  borrado,
  camposModificados,
  CAMPOS_TABLERO,
  creacion,
  tableroConColumnas,
} from "../domain/audit";
import { LIMITE_COLUMN_NAME, normalizarColumnKey } from "../domain/column-key";
import { DomainError } from "../domain/errors";
import { normalizarTexto } from "../domain/text";
import type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  CreateBoardInput,
  ListBoardsQuery,
  Page,
  UpdateBoardInput,
} from "../domain/types";
import { AuditService } from "./audit-service";
import type { ParticipanteIdempotente } from "./participante";

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
   *
   * `participante` es el gancho de la 6.5 y es OPCIONAL: sin el —que es el caso
   * de todos los llamadores de hoy salvo POST /api/boards con cabecera
   * `Idempotency-Key`— esta operacion hace exactamente lo mismo que antes de
   * que existiera. Ver `ParticipanteIdempotente` para que puede y que no puede
   * hacer quien entra por ahi.
   */
  async create(
    input: CreateBoardInput,
    ctx: ActorContext,
    participante?: ParticipanteIdempotente<BoardDetail>,
  ): Promise<BoardDetail> {
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

      // Ultimo, y DENTRO del intento: lo que el participante guarda describe lo
      // que se va a devolver, asi que necesita el detalle ya armado. Si el
      // intento se aborta y se reintenta, su fila se va con la transaccion,
      // igual que la de auditoria.
      if (participante !== undefined) {
        await participante(detalle, tx);
      }

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
   * dos versiones se separen. Lo que el servicio SI hace es bloquear antes las
   * tareas que la cascada se va a llevar, para poder nombrarlas: ver el
   * comentario de la lectura, abajo.
   */
  async delete(boardId: string, ctx: ActorContext): Promise<void> {
    await this.#boards.inTransaction(async (tx) => {
      const actual = await tx.findBoard(boardId);
      if (actual === undefined) {
        throw tableroNoEncontrado(boardId);
      }

      // Se lee lo que se va a perder ANTES de borrarlo: despues del DELETE ya
      // no hay de donde sacarlo, y la 5.2 pide el recuento de las entidades
      // eliminadas en cascada. De las tareas se registran ademas los IDS, que
      // es lo que permite saber QUE se perdio y no solo cuanto.
      //
      // Y por eso la lectura de las tareas BLOQUEA, mientras la de las columnas
      // no: los ids tienen que ser exactamente los que la cascada se lleva, ni
      // uno mas ni uno menos, y una lectura sin bloqueo no da eso. Ve el
      // snapshot de REPEATABLE READ, que todavia incluye una tarea que otra
      // transaccion ya borro y commiteo; la cascada, que mira las filas vivas,
      // no la encuentra y no tiene con que chocar, asi que el borrado commitea
      // y el registro nombra una tarea que sigue existiendo. Con FOR UPDATE esa
      // fila ya no se puede bloquear, sale 40001 y el runner reintenta con un
      // snapshot nuevo. MEDIDO en los dos sentidos: sin bloqueo, 3 ids
      // registrados contra 2 tareas borradas; con bloqueo, 2 y 2 en dos
      // intentos. El caso inverso —una tarea CREADA despues del snapshot— no
      // necesita nada de esto: la cascada la ve y aborta sola con 40001.
      const columnas = await tx.readBoardColumns(boardId);
      const tareas = await tx.lockBoardTaskIds(boardId);

      await tx.deleteBoard(boardId);
      await this.#audit.registrar(
        tx,
        ctx,
        borrado("board", boardId, tableroConColumnas({ ...actual, columns: columnas }), {
          tasks: tareas.length,
          // Ordenados por id y no en el orden de bloqueo: `column_id` es justo
          // lo que esta por dejar de existir, asi que un orden que dependa de
          // el no se puede reconstruir desde el registro.
          task_ids: [...tareas].sort(),
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
