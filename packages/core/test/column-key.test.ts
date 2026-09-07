import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BoardRepository,
  BoardService,
  DomainError,
  TaskRepository,
  TaskService,
  TransactionRunner,
} from "../src/index.js";
import { connectDb, ctx, porKey, truncateAll, uuid } from "./helpers.js";

let db: Client;
let tableros: BoardService;
let tareas: TaskService;

beforeAll(async () => {
  db = await connectDb();
  const runner = new TransactionRunner(prisma);
  tableros = new BoardService(new BoardRepository(runner));
  tareas = new TaskService(new TaskRepository(runner));
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function capturarDominio(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return error;
    }
    throw error;
  }
  throw new Error("Se esperaba un DomainError, pero la operacion termino sin error.");
}

interface Tablero {
  id: string;
  backlog: string;
  todo: string;
  inProgress: string;
}

async function sembrar(nombre = "Personal"): Promise<Tablero> {
  const tablero = await tableros.create({ name: nombre }, ctx());
  return {
    id: tablero.id,
    backlog: porKey(tablero.columns, "BACKLOG"),
    todo: porKey(tablero.columns, "TODO"),
    inProgress: porKey(tablero.columns, "IN_PROGRESS"),
  };
}

describe("create con columnKey", () => {
  it("resuelve a la misma columna que columnId", async () => {
    const t = await sembrar();

    const porId = await tareas.create({ boardId: t.id, columnId: t.todo, title: "Por id" }, ctx());
    const porClave = await tareas.create(
      { boardId: t.id, columnKey: "TODO", title: "Por key" },
      ctx(),
    );

    expect(porClave.columnId).toBe(porId.columnId);
    expect(porClave.columnId).toBe(t.todo);
  });

  it("resuelve con otra capitalizacion y blancos alrededor", async () => {
    const t = await sembrar();

    const creada = await tareas.create({
      boardId: t.id,
      columnKey: "  in progress  ",
      title: "Normalizada",
    }, ctx());

    expect(creada.columnId).toBe(t.inProgress);
  });

  it("si vienen los dos, gana columnId", async () => {
    const t = await sembrar();

    const creada = await tareas.create({
      boardId: t.id,
      columnId: t.backlog,
      columnKey: "TODO",
      title: "Ambas",
    }, ctx());

    expect(creada.columnId).toBe(t.backlog);
  });

  it("COLUMN_NOT_FOUND si la key no existe en el tablero", async () => {
    const t = await sembrar();

    const error = await capturarDominio(() =>
      tareas.create({ boardId: t.id, columnKey: "NO_EXISTE", title: "X" }, ctx()),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
    expect(error.details).toMatchObject({ boardId: t.id, columnKey: "NO_EXISTE" });
  });

  it("no resuelve contra una columna de otro tablero", async () => {
    const t = await sembrar("Personal");
    const otro = await tableros.create({
      name: "Otro",
      columns: [{ name: "En revision", key: "REVIEW" }],
    }, ctx());

    const error = await capturarDominio(() =>
      tareas.create({ boardId: t.id, columnKey: "REVIEW", title: "X" }, ctx()),
    );

    // La key existe, pero en otro tablero: el ambito de resolucion es el
    // tablero indicado, no la base entera.
    expect(error.code).toBe("COLUMN_NOT_FOUND");
    expect(porKey(otro.columns, "REVIEW")).toBeDefined();
  });
});

describe("move con columnKey", () => {
  it("resuelve a la misma columna que columnId", async () => {
    const t = await sembrar();
    const unaTarea = await tareas.create(
      { boardId: t.id, columnId: t.backlog, title: "Una" },
      ctx(),
    );
    const otraTarea = await tareas.create(
      { boardId: t.id, columnId: t.backlog, title: "Otra" },
      ctx(),
    );

    const porId = await tareas.move(unaTarea.id, { columnId: t.todo, position: 0 }, ctx());
    const porClave = await tareas.move(otraTarea.id, { columnKey: "todo", position: 0 }, ctx());

    expect(porId.toColumnId).toBe(t.todo);
    expect(porClave.toColumnId).toBe(t.todo);
    expect(porClave.task.columnId).toBe(t.todo);
  });

  it("si vienen los dos, gana columnId", async () => {
    const t = await sembrar();
    const tarea = await tareas.create({ boardId: t.id, columnId: t.backlog, title: "Una" }, ctx());

    const movida = await tareas.move(tarea.id, {
      columnId: t.inProgress,
      columnKey: "TODO",
      position: 0,
    }, ctx());

    expect(movida.toColumnId).toBe(t.inProgress);
  });

  it("COLUMN_NOT_FOUND si la key no existe en el tablero de la tarea", async () => {
    const t = await sembrar();
    const tarea = await tareas.create({ boardId: t.id, columnId: t.backlog, title: "Una" }, ctx());

    const error = await capturarDominio(() =>
      tareas.move(tarea.id, { columnKey: "NO_EXISTE", position: 0 }, ctx()),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("resuelve en el tablero de la tarea aunque la key exista en los dos", async () => {
    // Los dos tableros tienen una columna TODO. La tarea es del primero, asi
    // que tiene que caer en la TODO del primero.
    const t = await sembrar("Personal");
    const otro = await sembrar("Otro");
    expect(t.todo).not.toBe(otro.todo);

    const tarea = await tareas.create({ boardId: t.id, columnId: t.backlog, title: "Una" }, ctx());
    const movida = await tareas.move(tarea.id, { columnKey: "TODO", position: 0 }, ctx());

    expect(movida.toColumnId).toBe(t.todo);
    expect(movida.task.boardId).toBe(t.id);
  });

  it("no resuelve contra una columna que solo existe en otro tablero", async () => {
    const t = await sembrar("Personal");
    await tableros.create(
      { name: "Otro", columns: [{ name: "En revision", key: "REVIEW" }] },
      ctx(),
    );
    const tarea = await tareas.create({ boardId: t.id, columnId: t.backlog, title: "Una" }, ctx());

    const error = await capturarDominio(() =>
      tareas.move(tarea.id, { columnKey: "REVIEW", position: 0 }, ctx()),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("TASK_NOT_FOUND si la tarea no existe, sin llegar a resolver la key", async () => {
    await sembrar();

    const error = await capturarDominio(() =>
      tareas.move(uuid(), { columnKey: "TODO", position: 0 }, ctx()),
    );

    expect(error.code).toBe("TASK_NOT_FOUND");
  });

  it("un columnId de otro tablero sigue dando COLUMN_NOT_IN_BOARD", async () => {
    // La asercion de pertenencia es la autoridad, venga la columna de un id o
    // de una key: este es el camino por id, que no cambio.
    const t = await sembrar("Personal");
    const otro = await sembrar("Otro");
    const tarea = await tareas.create({ boardId: t.id, columnId: t.backlog, title: "Una" }, ctx());

    const error = await capturarDominio(() =>
      tareas.move(tarea.id, { columnId: otro.todo, position: 0 }, ctx()),
    );

    expect(error.code).toBe("COLUMN_NOT_IN_BOARD");
    expect(error.details).toMatchObject({
      taskId: tarea.id,
      columnId: otro.todo,
      taskBoardId: t.id,
      columnBoardId: otro.id,
    });
  });
});

describe("list con columnKey", () => {
  it("filtra igual que con columnId", async () => {
    const t = await sembrar();
    const enTodo = await tareas.create(
      { boardId: t.id, columnId: t.todo, title: "En todo" },
      ctx(),
    );
    await tareas.create({ boardId: t.id, columnId: t.backlog, title: "En backlog" }, ctx());

    const porId = await tareas.list({ boardId: t.id, columnId: t.todo });
    const porClave = await tareas.list({ boardId: t.id, columnKey: " todo " });

    expect(porClave.items.map((tarea) => tarea.id)).toEqual([enTodo.id]);
    expect(porClave.items.map((tarea) => tarea.id)).toEqual(porId.items.map((tarea) => tarea.id));
  });

  it("si vienen los dos, gana columnId", async () => {
    const t = await sembrar();
    const enBacklog = await tareas.create({
      boardId: t.id,
      columnId: t.backlog,
      title: "En backlog",
    }, ctx());
    await tareas.create({ boardId: t.id, columnId: t.todo, title: "En todo" }, ctx());

    const pagina = await tareas.list({ boardId: t.id, columnId: t.backlog, columnKey: "TODO" });

    expect(pagina.items.map((tarea) => tarea.id)).toEqual([enBacklog.id]);
  });

  it("una columnKey sin boardId es un error accionable", async () => {
    await sembrar();

    const error = await capturarDominio(() => tareas.list({ columnKey: "TODO" }));

    expect(error.code).toBe("COLUMN_NOT_FOUND");
    expect(error.hint).toContain("boardId");
  });

  it("COLUMN_NOT_FOUND si la key no existe en el tablero", async () => {
    const t = await sembrar();

    const error = await capturarDominio(() =>
      tareas.list({ boardId: t.id, columnKey: "NO_EXISTE" }),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });
});
