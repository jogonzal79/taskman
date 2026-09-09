import { prisma } from "@taskman/db";

import { BoardRepository } from "../db/board-repository.js";
import { TaskRepository } from "../db/task-repository.js";
import { TransactionRunner } from "../db/transaction-runner.js";
import type { ActorContext } from "../domain/actor.js";
import type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  Column,
  CreateBoardInput,
  CreateColumnInput,
  CreateTaskInput,
  ListBoardsQuery,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  SearchScope,
  Task,
  TaskMatch,
  UpdateBoardInput,
  UpdateTaskInput,
} from "../domain/types.js";
import { AuditService } from "../services/audit-service.js";
import { BoardService } from "../services/board-service.js";
import { ColumnService } from "../services/column-service.js";
import { TaskService } from "../services/task-service.js";
import type { TaskManagerPort } from "./port.js";

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

  constructor(services: { boards: BoardService; columns: ColumnService; tasks: TaskService }) {
    this.#boards = services.boards;
    this.#columns = services.columns;
    this.#tasks = services.tasks;
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

  async createBoard(input: CreateBoardInput, ctx: ActorContext): Promise<BoardDetail> {
    return this.#boards.create(input, ctx);
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

  async createColumn(input: CreateColumnInput, ctx: ActorContext): Promise<Column> {
    return this.#columns.create(input, ctx);
  }

  async listTasks(query: ListTasksQuery): Promise<Page<Task>> {
    return this.#tasks.list(query);
  }

  async getTask(taskId: string): Promise<Task> {
    return this.#tasks.get(taskId);
  }

  async createTask(input: CreateTaskInput, ctx: ActorContext): Promise<Task> {
    return this.#tasks.create(input, ctx);
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
  });
}
