import { prisma } from "@taskman/db";

import { AuditRepository } from "../db/audit-repository";
import { BoardRepository } from "../db/board-repository";
import { IdempotencyRepository, type IdempotencyRecord } from "../db/idempotency-repository";
import { TaskRepository } from "../db/task-repository";
import { TransactionRunner } from "../db/transaction-runner";
import type { ActorContext } from "../domain/actor";
import type {
  AuditEntry,
  ListAuditQuery,
} from "../domain/audit";
import type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  Column,
  ColumnWithOrder,
  CreateBoardInput,
  CreateColumnInput,
  CreateTaskInput,
  DeleteColumnOptions,
  ListBoardsQuery,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  SearchScope,
  Task,
  TaskMatch,
  UpdateBoardInput,
  UpdateColumnInput,
  UpdateTaskInput,
} from "../domain/types";
import { AuditQueryService } from "../services/audit-query-service";
import { AuditService } from "../services/audit-service";
import { BoardService } from "../services/board-service";
import { ColumnService } from "../services/column-service";
import type { ParticipanteIdempotente } from "../services/participante";
import { TaskService } from "../services/task-service";
import type { TaskManagerPort } from "./port";

/**
 * `TaskManagerPort` resuelto invocando los servicios en el mismo proceso.
 *
 * Es el modo `MCP_PORT_MODE=core` de la 8.1: el servidor MCP corre en la misma
 * maquina que la base y habla con ella directamente, sin pasar por HTTP. No
 * agrega ninguna regla; es un cambio de forma, no de comportamiento.
 */
export class CorePort implements TaskManagerPort {
  readonly #boards: BoardService;
  readonly #columns: ColumnService;
  readonly #tasks: TaskService;
  readonly #audit: AuditQueryService;
  readonly #idempotency: IdempotencyRepository;

  constructor(services: {
    boards: BoardService;
    columns: ColumnService;
    tasks: TaskService;
    audit: AuditQueryService;
    idempotency: IdempotencyRepository;
  }) {
    this.#boards = services.boards;
    this.#columns = services.columns;
    this.#tasks = services.tasks;
    this.#audit = services.audit;
    this.#idempotency = services.idempotency;
  }

  async listBoards(query: ListBoardsQuery): Promise<Page<Board>> {
    return this.#boards.list(query);
  }

  async getBoard(boardId: string): Promise<BoardDetail> {
    return this.#boards.get(boardId);
  }

  /**
   * Para GET /api/boards/{id} (6.2). Deliberadamente NO esta en
   * `TaskManagerPort`: el recuento lo pide el borde REST, y la herramienta MCP
   * get_board ya arma el suyo por su cuenta. Agregarlo a la interfaz obligaria
   * a implementarlo tambien al HttpPort que todavia no existe, para nadie.
   */
  async getBoardWithTaskCounts(boardId: string): Promise<BoardWithTaskCounts> {
    return this.#boards.getWithTaskCounts(boardId);
  }

  /**
   * El tercer parametro es el gancho de la 6.5 y NO esta en `TaskManagerPort`:
   * es opcional, asi que esta firma sigue satisfaciendo la del puerto, y el
   * borde MCP —que no tiene cabeceras HTTP y por lo tanto no tiene
   * `Idempotency-Key`— no se entera de que existe. Mismo criterio que
   * `getBoardWithTaskCounts` y `updateBoard`: lo que solo necesita REST llega
   * por la clase concreta que devuelve `crearCorePort()`, no por la interfaz.
   */
  async createBoard(
    input: CreateBoardInput,
    ctx: ActorContext,
    participante?: ParticipanteIdempotente<BoardDetail>,
  ): Promise<BoardDetail> {
    return this.#boards.create(input, ctx, participante);
  }

  /**
   * La consulta previa de la 6.5. Es una LECTURA suelta y por eso no lleva
   * `ctx`: no se audita (7.4) y no abre transaccion.
   *
   * Vive en el puerto y no en el adaptador porque ningun adaptador importa
   * Prisma (3.2). Lo que el borde HTTP calcula —la canonicalizacion del cuerpo
   * y su SHA-256— se queda del lado del borde: el nucleo solo guarda y devuelve
   * la cadena.
   */
  async findIdempotencyRecord(key: string, clientId: string): Promise<IdempotencyRecord | undefined> {
    return this.#idempotency.find(key, clientId);
  }

  /**
   * Para PATCH /api/boards/{id} (6.2). Igual que `getBoardWithTaskCounts`, va
   * SOLO aca y no en `TaskManagerPort`: el catalogo de la 8.2 no tiene una
   * herramienta `update_board`, asi que sumarlo a la interfaz obligaria a
   * implementarlo tambien al HttpPort que todavia no existe, para ningun
   * llamador. `crearCorePort()` devuelve la clase concreta, asi que el
   * adaptador REST lo alcanza sin ampliar el puerto.
   */
  async updateBoard(
    boardId: string,
    patch: UpdateBoardInput,
    ctx: ActorContext,
  ): Promise<BoardDetail> {
    return this.#boards.update(boardId, patch, ctx);
  }

  /**
   * Para DELETE /api/boards/{id} (6.2). Va SOLO aca por lo mismo que
   * `updateBoard` y `getBoardWithTaskCounts`: la 8.2 no tiene una herramienta
   * `delete_board` —la unica destructiva del catalogo es `delete_task`— asi que
   * sumarlo al puerto obligaria a implementarlo en el HttpPort que no existe.
   *
   * Devuelve void porque eso devuelve el servicio: lo borrado ya no esta y no
   * hay nada que informar de vuelta. El recuento de lo que se llevo la cascada
   * queda en el registro de auditoria, no en el valor de retorno.
   */
  async deleteBoard(boardId: string, ctx: ActorContext): Promise<void> {
    return this.#boards.delete(boardId, ctx);
  }

  /**
   * El tercer parametro es el gancho de la 6.5, opcional y fuera de
   * `TaskManagerPort` por lo mismo que en `createBoard`. Lo que ve el
   * participante es `ColumnWithOrder` y no la columna sola: ver
   * `ColumnService.create`.
   */
  async createColumn(
    input: CreateColumnInput,
    ctx: ActorContext,
    participante?: ParticipanteIdempotente<ColumnWithOrder>,
  ): Promise<Column> {
    return this.#columns.create(input, ctx, participante);
  }

  /**
   * Para PATCH /api/columns/{id} (6.2). Va SOLO aca y no en `TaskManagerPort`,
   * por lo mismo que `updateBoard` y `deleteBoard`: el catalogo de la 8.2 no
   * tiene una herramienta `update_column`, asi que sumarlo a la interfaz
   * obligaria a implementarlo tambien al HttpPort que todavia no existe, para
   * ningun llamador. `crearCorePort()` devuelve la clase concreta, asi que el
   * adaptador REST lo alcanza sin ampliar el puerto.
   */
  async updateColumn(
    columnId: string,
    patch: UpdateColumnInput,
    ctx: ActorContext,
  ): Promise<Column> {
    return this.#columns.update(columnId, patch, ctx);
  }

  /**
   * Para DELETE /api/columns/{id} (6.2). Igual que `updateColumn`: la 8.2 no
   * tiene `delete_column` —la unica destructiva del catalogo es `delete_task`—
   * asi que no entra en el puerto.
   *
   * Devuelve void porque eso devuelve el servicio. El recuento de tareas
   * reasignadas queda en el registro de auditoria, no en el valor de retorno.
   */
  async deleteColumn(
    columnId: string,
    options: DeleteColumnOptions,
    ctx: ActorContext,
  ): Promise<void> {
    return this.#columns.delete(columnId, options, ctx);
  }

  async listTasks(query: ListTasksQuery): Promise<Page<Task>> {
    return this.#tasks.list(query);
  }

  async getTask(taskId: string): Promise<Task> {
    return this.#tasks.get(taskId);
  }

  /** Igual que `createBoard`: tercer parametro opcional, ausente del puerto. */
  async createTask(
    input: CreateTaskInput,
    ctx: ActorContext,
    participante?: ParticipanteIdempotente<Task>,
  ): Promise<Task> {
    return this.#tasks.create(input, ctx, participante);
  }

  async updateTask(taskId: string, patch: UpdateTaskInput, ctx: ActorContext): Promise<Task> {
    return this.#tasks.update(taskId, patch, ctx);
  }

  async moveTask(taskId: string, target: MoveTarget, ctx: ActorContext): Promise<MoveResult> {
    return this.#tasks.move(taskId, target, ctx);
  }

  async deleteTask(taskId: string, ctx: ActorContext): Promise<void> {
    return this.#tasks.delete(taskId, ctx);
  }

  async searchTasks(text: string, scope: SearchScope): Promise<Page<TaskMatch>> {
    return this.#tasks.search(text, scope);
  }

  /**
   * Para GET /api/audit (6.2, RF-10). Va SOLO aca y no en `TaskManagerPort`,
   * por lo mismo que `updateBoard`, `deleteBoard`, `updateColumn` y
   * `deleteColumn`: el catalogo de la 8.2 no tiene ninguna herramienta de
   * auditoria, asi que sumarlo a la interfaz obligaria a implementarlo tambien
   * en el HttpPort que todavia no existe, para ningun llamador.
   *
   * Es la unica LECTURA que se agrega al puerto sin pasar por los tres
   * servicios de entidad, y por eso el campo es un servicio aparte: ver
   * `AuditQueryService`.
   */
  async listAudit(query: ListAuditQuery): Promise<Page<AuditEntry>> {
    return this.#audit.list(query);
  }
}

/**
 * Arma un `CorePort` sobre el cliente Prisma compartido.
 *
 * El cableado vive aca y no en `apps/mcp-stdio` a proposito: ningun adaptador
 * importa Prisma directamente (ver CLAUDE.md), asi que la app pide un puerto y
 * no sabe que hay repositorios, transacciones ni un ORM del otro lado.
 */
export function crearCorePort(): CorePort {
  const runner = new TransactionRunner(prisma);
  const boards = new BoardRepository(runner);
  // Un solo AuditService para los tres: no tiene estado, y compartirlo deja
  // claro que la auditoria es una sola politica y no tres.
  const audit = new AuditService();
  return new CorePort({
    boards: new BoardService(boards, audit),
    columns: new ColumnService(boards, audit),
    tasks: new TaskService(new TaskRepository(runner), audit),
    // El de LECTURA es otro objeto y otro repositorio: ver AuditQueryService.
    audit: new AuditQueryService(new AuditRepository(runner)),
    // Tambien solo de lectura: la ESCRITURA del registro de idempotencia no
    // pasa por aca, va con la transaccion de la operacion (6.5).
    idempotency: new IdempotencyRepository(runner),
  });
}
