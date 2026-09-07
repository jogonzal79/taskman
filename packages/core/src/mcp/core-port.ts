import { prisma } from "@taskman/db";

import { BoardRepository } from "../db/board-repository.js";
import { TaskRepository } from "../db/task-repository.js";
import { TransactionRunner } from "../db/transaction-runner.js";
import type {
  Board,
  BoardDetail,
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
  UpdateTaskInput,
} from "../domain/types.js";
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

  async createBoard(input: CreateBoardInput): Promise<BoardDetail> {
    return this.#boards.create(input);
  }

  async createColumn(input: CreateColumnInput): Promise<Column> {
    return this.#columns.create(input);
  }

  async listTasks(query: ListTasksQuery): Promise<Page<Task>> {
    return this.#tasks.list(query);
  }

  async getTask(taskId: string): Promise<Task> {
    return this.#tasks.get(taskId);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.#tasks.create(input);
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task> {
    return this.#tasks.update(taskId, patch);
  }

  async moveTask(taskId: string, target: MoveTarget): Promise<MoveResult> {
    return this.#tasks.move(taskId, target);
  }

  async deleteTask(taskId: string): Promise<void> {
    return this.#tasks.delete(taskId);
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
  return new CorePort({
    boards: new BoardService(boards),
    columns: new ColumnService(boards),
    tasks: new TaskService(new TaskRepository(runner)),
  });
}
