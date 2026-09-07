import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BoardRepository,
  BoardService,
  COLUMNAS_POR_DEFECTO,
  DomainError,
  TaskRepository,
  TaskService,
  TransactionRunner,
} from "../src/index.js";
import { connectDb, contarFilas, ctx, porKey, truncateAll, uuid } from "./helpers.js";

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

describe("create", () => {
  it("sin columnas crea las cuatro por defecto de la 4.3", async () => {
    const tablero = await tableros.create({ name: "Personal" }, ctx());

    // Orden, keys y nombres exactos: son el contrato con el que los agentes
    // resuelven referencias por nombre.
    expect(tablero.columns.map((columna) => [columna.position, columna.key, columna.name])).toEqual([
      [0, "BACKLOG", "Backlog"],
      [1, "TODO", "Por hacer"],
      [2, "IN_PROGRESS", "En progreso"],
      [3, "DONE", "Completado"],
    ]);
    expect(COLUMNAS_POR_DEFECTO.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
  });

  it("con columnas explicitas respeta el orden dado y normaliza las keys", async () => {
    const tablero = await tableros.create({
      name: "Custom",
      columns: [
        { name: "Ideas", key: " ideas " },
        { name: "En revision", key: "en revision" },
      ],
    }, ctx());

    expect(tablero.columns.map((columna) => [columna.position, columna.key])).toEqual([
      [0, "IDEAS"],
      [1, "EN_REVISION"],
    ]);
  });

  it("rechaza dos columnas con la misma key", async () => {
    const error = await capturarDominio(() =>
      tableros.create({
        name: "Custom",
        columns: [
          { name: "Uno", key: "todo" },
          { name: "Dos", key: " TODO " },
        ],
      }, ctx()),
    );

    expect(error.code).toBe("DUPLICATE_KEY");
    expect(await contarFilas(db, "board")).toBe(0);
  });

  it("guarda el nombre recortado y rechaza uno en blanco", async () => {
    const tablero = await tableros.create({ name: "  Personal  " }, ctx());
    expect(tablero.name).toBe("Personal");

    const error = await capturarDominio(() => tableros.create({ name: " " }, ctx()));
    expect(error.code).toBe("NAME_REQUIRED");
  });

  it("rechaza un nombre de mas de 120 caracteres con error de dominio", async () => {
    const error = await capturarDominio(() => tableros.create({ name: "a".repeat(121) }, ctx()));

    expect(error.code).toBe("NAME_TOO_LONG");
    expect(error.details).toMatchObject({ field: "name", length: 121, maxLength: 120 });
  });

  it("rechaza una descripcion de mas de 2000 caracteres", async () => {
    const error = await capturarDominio(() =>
      tableros.create({ name: "Personal", description: "a".repeat(2001) }, ctx()),
    );

    expect(error.code).toBe("DESCRIPTION_TOO_LONG");
  });

  it("el tablero y sus columnas se crean en la misma transaccion", async () => {
    const error = await capturarDominio(() =>
      tableros.create(
        { name: "Roto", columns: [{ name: "Ok", key: "OK" }, { name: " ", key: "X" }] },
        ctx(),
      ),
    );

    expect(error.code).toBe("NAME_REQUIRED");
    // Ni el tablero ni la primera columna quedaron a medias.
    expect(await contarFilas(db, "board")).toBe(0);
    expect(await contarFilas(db, "board_column")).toBe(0);
  });
});

describe("get, list y update", () => {
  it("get devuelve el tablero con sus columnas en orden", async () => {
    const creado = await tableros.create({ name: "Personal" }, ctx());

    const leido = await tableros.get(creado.id);

    expect(leido.id).toBe(creado.id);
    expect(leido.columns.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
  });

  it("get da BOARD_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => tableros.get(uuid()));
    expect(error.code).toBe("BOARD_NOT_FOUND");
  });

  it("list pagina por cursor", async () => {
    for (const nombre of ["Alfa", "Beta", "Gamma"]) {
      await tableros.create({ name: nombre }, ctx());
    }

    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let vuelta = 0; vuelta < 10; vuelta += 1) {
      const pagina: { items: Array<{ name: string }>; nextCursor: string | null } =
        await tableros.list({ limit: 2, ...(cursor === null ? {} : { cursor }) });
      vistos.push(...pagina.items.map((tablero) => tablero.name));
      cursor = pagina.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(vistos).toEqual(["Alfa", "Beta", "Gamma"]);
  });

  it("update cambia nombre y descripcion, y sin cambio efectivo no escribe", async () => {
    const creado = await tableros.create({ name: "Personal" }, ctx());

    const renombrado = await tableros.update(creado.id, { name: "Trabajo" }, ctx());
    expect(renombrado.name).toBe("Trabajo");
    expect(renombrado.columns).toHaveLength(4);

    const sinCambio = await tableros.update(creado.id, { name: "Trabajo" }, ctx());
    expect(sinCambio.updatedAt.getTime()).toBe(renombrado.updatedAt.getTime());
  });
});

describe("delete", () => {
  it("se lleva columnas y tareas en cascada, sin error", async () => {
    const tablero = await tableros.create({ name: "Personal" }, ctx());
    await tareas.create({
      boardId: tablero.id,
      columnId: porKey(tablero.columns, "BACKLOG"),
      title: "Una",
    }, ctx());
    await tareas.create({
      boardId: tablero.id,
      columnId: porKey(tablero.columns, "TODO"),
      title: "Otra",
    }, ctx());

    await tableros.delete(tablero.id, ctx());

    expect(await contarFilas(db, "board")).toBe(0);
    expect(await contarFilas(db, "board_column")).toBe(0);
    expect(await contarFilas(db, "task")).toBe(0);
  });

  it("no toca los otros tableros", async () => {
    const uno = await tableros.create({ name: "Uno" }, ctx());
    const dos = await tableros.create({ name: "Dos" }, ctx());
    await tareas.create({
      boardId: dos.id,
      columnId: porKey(dos.columns, "TODO"),
      title: "Sobrevive",
    }, ctx());

    await tableros.delete(uno.id, ctx());

    expect(await contarFilas(db, "board")).toBe(1);
    expect(await contarFilas(db, "task")).toBe(1);
  });

  it("BOARD_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => tableros.delete(uuid(), ctx()));
    expect(error.code).toBe("BOARD_NOT_FOUND");
  });
});
