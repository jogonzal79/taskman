import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BoardRepository, BoardService, AuditService, TransactionRunner } from "../src/index.js";
import { prisma } from "@taskman/db";
import { connectDb, ctx, insertColumn, insertTask, insertTasks, truncateAll, uuid } from "./helpers.js";

/**
 * `BoardService.getWithTaskCounts`: lo que devuelve GET /api/boards/{id} (6.2).
 *
 * Lo que se prueba aca y no en el borde es el recuento en si: que salga de un
 * GROUP BY significa que las columnas sin tareas NO vienen en el resultado de
 * la consulta, y resolver esa ausencia como cero es justamente donde esto se
 * puede romper sin que nada mas se entere.
 */

let client: Client;
let boards: BoardService;

beforeAll(async () => {
  client = await connectDb();
  const repo = new BoardRepository(new TransactionRunner(prisma));
  boards = new BoardService(repo, new AuditService());
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
});

async function tableroConColumnas(): Promise<{ boardId: string; todo: string; done: string }> {
  const boardId = uuid();
  await client.query(`INSERT INTO board (id, name) VALUES ($1, $2)`, [boardId, "Tablero"]);
  const todo = await insertColumn(client, { boardId, key: "TODO", position: 0 });
  const done = await insertColumn(client, { boardId, key: "DONE", position: 1 });
  return { boardId, todo, done };
}

describe("BoardService.getWithTaskCounts", () => {
  it("una columna sin tareas cuenta cero, no desaparece del resultado", async () => {
    // El caso que rompe si se confia en el GROUP BY tal cual: DONE no aparece
    // en sus filas, y sin el `?? 0` la columna se perderia o quedaria en
    // undefined.
    const { boardId, todo, done } = await tableroConColumnas();
    await insertTask(client, { boardId, columnId: todo, title: "Sola", position: 0 });

    const detalle = await boards.getWithTaskCounts(boardId);

    expect(detalle.columns).toHaveLength(2);
    expect(detalle.columns.find((c) => c.id === todo)?.taskCount).toBe(1);
    expect(detalle.columns.find((c) => c.id === done)?.taskCount).toBe(0);
  });

  it("un tablero sin ninguna tarea da todos los recuentos en cero", async () => {
    const { boardId } = await tableroConColumnas();

    const detalle = await boards.getWithTaskCounts(boardId);

    expect(detalle.columns.map((c) => c.taskCount)).toEqual([0, 0]);
    expect(detalle.taskCount).toBe(0);
  });

  it("cuenta por columna y el total es la suma", async () => {
    const { boardId, todo, done } = await tableroConColumnas();
    await insertTasks(client, { boardId, columnId: todo, prefijo: "t", cantidad: 3 });
    await insertTasks(client, { boardId, columnId: done, prefijo: "d", cantidad: 2 });

    const detalle = await boards.getWithTaskCounts(boardId);

    expect(detalle.columns.find((c) => c.id === todo)?.taskCount).toBe(3);
    expect(detalle.columns.find((c) => c.id === done)?.taskCount).toBe(2);
    expect(detalle.taskCount).toBe(5);
    // El total es la suma de lo que se muestra, no una consulta aparte: si
    // alguna vez dejan de cuadrar, es que se separaron en dos lecturas.
    expect(detalle.taskCount).toBe(
      detalle.columns.reduce((total, columna) => total + columna.taskCount, 0),
    );
  });

  it("no cuenta tareas de otro tablero", async () => {
    const propio = await tableroConColumnas();
    const ajeno = await tableroConColumnas();
    await insertTasks(client, {
      boardId: ajeno.boardId,
      columnId: ajeno.todo,
      prefijo: "otro",
      cantidad: 4,
    });

    const detalle = await boards.getWithTaskCounts(propio.boardId);

    expect(detalle.taskCount).toBe(0);
  });

  it("conserva el orden de las columnas y los campos del tablero", async () => {
    const { boardId, todo, done } = await tableroConColumnas();

    const detalle = await boards.getWithTaskCounts(boardId);

    expect(detalle.columns.map((c) => c.id)).toEqual([todo, done]);
    expect(detalle.columns.map((c) => c.position)).toEqual([0, 1]);
    expect(detalle.name).toBe("Tablero");
    expect(detalle.description).toBeNull();
    expect(detalle.createdAt).toBeInstanceOf(Date);
  });

  it("un tablero que no existe lanza BOARD_NOT_FOUND", async () => {
    // Mismo error que `get`: el recuento no cambia que el tablero no este.
    await expect(boards.getWithTaskCounts(uuid())).rejects.toMatchObject({
      code: "BOARD_NOT_FOUND",
    });
  });

  it("refleja las tareas creadas por el servicio, no solo las sembradas", async () => {
    // Cierra el circuito con el camino real de escritura: si el recuento se
    // calculara sobre otra cosa (una cache, una columna materializada), esto lo
    // detectaria.
    const detalleInicial = await boards.create({ name: "Con columnas por defecto" }, ctx());
    const primera = detalleInicial.columns[0];
    if (primera === undefined) throw new Error("El tablero por defecto no trajo columnas.");

    await insertTask(client, {
      boardId: detalleInicial.id,
      columnId: primera.id,
      title: "Nueva",
      position: 0,
    });

    const detalle = await boards.getWithTaskCounts(detalleInicial.id);

    expect(detalle.taskCount).toBe(1);
    expect(detalle.columns.find((c) => c.id === primera.id)?.taskCount).toBe(1);
  });
});
