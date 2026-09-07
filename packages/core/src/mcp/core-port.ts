import { prisma } from "@taskman/db";

import { BoardRepository } from "../db/board-repository.js";
import { TaskRepository } from "../db/task-repository.js";
import { TransactionRunner } from "../db/transaction-runner.js";
import type {
  Board,
  BoardDetail,
  CreateTaskInput,
  ListBoardsQuery,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  Task,
} from "../domain/types.js";
import { BoardService } from "../services/board-service.js";
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
  readonly #tasks: TaskService;

  constructor(services: { boards: BoardService; tasks: TaskService }) {
    this.#boards = services.boards;
    this.#tasks = services.tasks;
  }

  async listBoards(query: ListBoardsQuery): Promise<Page<Board>> {
    return this.#boards.list(query);
  }

  async getBoard(boardId: string): Promise<BoardDetail> {
    return this.#boards.get(boardId);
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

  async moveTask(taskId: string, target: MoveTarget): Promise<MoveResult> {
    return this.#tasks.move(taskId, target);
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
  return new CorePort({
    boards: new BoardService(new BoardRepository(runner)),
    tasks: new TaskService(new TaskRepository(runner)),
  });
}
