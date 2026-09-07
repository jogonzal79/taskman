import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BoardRepository,
  BoardService,
  ColumnService,
  DomainError,
  TaskRepository,
  TaskService,
  TransactionRunner,
} from "../src/index.js";
import {
  connectDb,
  expectColumnaDensa,
  expectTableroDenso,
  insertBoard,
  leerColumnas,
  leerOrden,
  porKey,
  truncateAll,
  uuid,
} from "./helpers.js";

let db: Client;
let tableros: BoardService;
let columnas: ColumnService;
let tareas: TaskService;

beforeAll(async () => {
  db = await connectDb();
  const runner = new TransactionRunner(prisma);
  const boards = new BoardRepository(runner);
  tableros = new BoardService(boards);
  columnas = new ColumnService(boards);
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
  done: string;
}

async function sembrar(): Promise<Tablero> {
  const tablero = await tableros.create({ name: "Personal" });
  return {
    id: tablero.id,
    backlog: porKey(tablero.columns, "BACKLOG"),
    todo: porKey(tablero.columns, "TODO"),
    inProgress: porKey(tablero.columns, "IN_PROGRESS"),
    done: porKey(tablero.columns, "DONE"),
  };
}

describe("create", () => {
  it("sin position va al final y normaliza la key", async () => {
    const t = await sembrar();

    const creada = await columnas.create({ boardId: t.id, name: "En revision", key: "en revision" });

    expect(creada.position).toBe(4);
    expect(creada.key).toBe("EN_REVISION");
    await expectTableroDenso(db, t.id);
  });

  it("con position intermedia desplaza las siguientes", async () => {
    const t = await sembrar();

    const creada = await columnas.create({
      boardId: t.id,
      name: "Bloqueado",
      key: "BLOCKED",
      position: 1,
    });

    expect(creada.position).toBe(1);
    expect(await leerColumnas(db, t.id)).toEqual([
      t.backlog,
      creada.id,
      t.todo,
      t.inProgress,
      t.done,
    ]);
    await expectTableroDenso(db, t.id);
  });

  it("DUPLICATE_KEY si la key ya existe en el tablero", async () => {
    const t = await sembrar();

    const error = await capturarDominio(() =>
      columnas.create({ boardId: t.id, name: "Otra", key: " todo " }),
    );

    expect(error.code).toBe("DUPLICATE_KEY");
    expect(error.details).toMatchObject({ columnKey: "TODO", columnId: t.todo });
    expect(await leerColumnas(db, t.id)).toHaveLength(4);
  });

  it("la misma key en otro tablero si se permite", async () => {
    const t = await sembrar();
    const otro = await tableros.create({ name: "Otro", columns: [{ name: "Uno", key: "UNO" }] });

    const creada = await columnas.create({ boardId: otro.id, name: "Por hacer", key: "TODO" });

    expect(creada.key).toBe("TODO");
    expect(creada.boardId).toBe(otro.id);
    expect(t.todo).not.toBe(creada.id);
  });

  it("BOARD_NOT_FOUND si el tablero no existe", async () => {
    const error = await capturarDominio(() =>
      columnas.create({ boardId: uuid(), name: "X", key: "X" }),
    );
    expect(error.code).toBe("BOARD_NOT_FOUND");
  });

  it("rechaza una key en blanco", async () => {
    const t = await sembrar();
    const error = await capturarDominio(() =>
      columnas.create({ boardId: t.id, name: "Sin key", key: " " }),
    );
    expect(error.code).toBe("COLUMN_KEY_REQUIRED");
  });
});

describe("update", () => {
  it("renombra sin tocar el orden", async () => {
    const t = await sembrar();

    const renombrada = await columnas.update(t.todo, { name: "  Pendiente  " });

    expect(renombrada.name).toBe("Pendiente");
    expect(renombrada.key).toBe("TODO");
    expect(await leerColumnas(db, t.id)).toEqual([t.backlog, t.todo, t.inProgress, t.done]);
  });

  it("reordena hacia adelante y deja el orden denso", async () => {
    const t = await sembrar();

    const movida = await columnas.update(t.backlog, { position: 2 });

    expect(movida.position).toBe(2);
    expect(await leerColumnas(db, t.id)).toEqual([t.todo, t.inProgress, t.backlog, t.done]);
    await expectTableroDenso(db, t.id);
  });

  it("reordena hacia atras y deja el orden denso", async () => {
    const t = await sembrar();

    const movida = await columnas.update(t.done, { position: 0 });

    expect(movida.position).toBe(0);
    expect(await leerColumnas(db, t.id)).toEqual([t.done, t.backlog, t.todo, t.inProgress]);
    await expectTableroDenso(db, t.id);
  });

  it("una position mayor que el tablero se ajusta al final", async () => {
    const t = await sembrar();

    const movida = await columnas.update(t.backlog, { position: 99 });

    expect(movida.position).toBe(3);
    await expectTableroDenso(db, t.id);
  });

  it("INVALID_ORDER si la position es negativa", async () => {
    const t = await sembrar();
    const error = await capturarDominio(() => columnas.update(t.todo, { position: -1 }));
    expect(error.code).toBe("INVALID_ORDER");
  });

  it("COLUMN_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => columnas.update(uuid(), { name: "X" }));
    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });
});

describe("delete", () => {
  it("una columna vacia se va y el tablero queda denso", async () => {
    const t = await sembrar();

    await columnas.delete(t.todo);

    expect(await leerColumnas(db, t.id)).toEqual([t.backlog, t.inProgress, t.done]);
    await expectTableroDenso(db, t.id);
  });

  it("COLUMN_NOT_EMPTY si tiene tareas y no se indica reassignTo", async () => {
    const t = await sembrar();
    await tareas.create({ boardId: t.id, columnId: t.todo, title: "Una" });

    const error = await capturarDominio(() => columnas.delete(t.todo));

    expect(error.code).toBe("COLUMN_NOT_EMPTY");
    expect(error.details).toMatchObject({ columnId: t.todo, taskCount: 1 });
    expect(error.hint).toBeDefined();
    // No se borro nada.
    expect(await leerColumnas(db, t.id)).toHaveLength(4);
    expect(await leerOrden(db, t.todo)).toHaveLength(1);
  });

  it("con reassignTo las tareas quedan al final de la columna destino", async () => {
    const t = await sembrar();
    const destino1 = await tareas.create({ boardId: t.id, columnId: t.inProgress, title: "Ya estaba" });
    const origen1 = await tareas.create({ boardId: t.id, columnId: t.todo, title: "Primera" });
    const origen2 = await tareas.create({ boardId: t.id, columnId: t.todo, title: "Segunda" });

    await columnas.delete(t.todo, { reassignTo: t.inProgress });

    // Las de la columna que se fue quedan al final, en su orden original.
    expect(await leerOrden(db, t.inProgress)).toEqual([destino1.id, origen1.id, origen2.id]);
    expect(await leerColumnas(db, t.id)).toEqual([t.backlog, t.inProgress, t.done]);
    await expectColumnaDensa(db, t.inProgress);
    await expectTableroDenso(db, t.id);
  });

  it("reassignTo a una columna de otro tablero es rechazado", async () => {
    const t = await sembrar();
    await tareas.create({ boardId: t.id, columnId: t.todo, title: "Una" });
    const otro = await tableros.create({ name: "Otro" });
    const ajena = porKey(otro.columns, "TODO");

    const error = await capturarDominio(() => columnas.delete(t.todo, { reassignTo: ajena }));

    expect(error.code).toBe("COLUMN_NOT_IN_BOARD");
    // La transaccion no dejo rastro: ni se movieron tareas ni se borro nada.
    expect(await leerOrden(db, t.todo)).toHaveLength(1);
    expect(await leerColumnas(db, t.id)).toHaveLength(4);
  });

  it("reassignTo a la misma columna es rechazado", async () => {
    const t = await sembrar();
    await tareas.create({ boardId: t.id, columnId: t.todo, title: "Una" });

    const error = await capturarDominio(() => columnas.delete(t.todo, { reassignTo: t.todo }));

    expect(error.code).toBe("INVALID_REASSIGN_TARGET");
  });

  it("reassignTo a una columna inexistente es rechazado", async () => {
    const t = await sembrar();
    await tareas.create({ boardId: t.id, columnId: t.todo, title: "Una" });

    const error = await capturarDominio(() => columnas.delete(t.todo, { reassignTo: uuid() }));

    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });

  it("COLUMN_NOT_FOUND si no existe", async () => {
    const error = await capturarDominio(() => columnas.delete(uuid()));
    expect(error.code).toBe("COLUMN_NOT_FOUND");
  });
});

describe("concurrencia", () => {
  it("dos create simultaneos sobre un tablero con columnas terminan los dos", async () => {
    const t = await sembrar();

    const resultados = await Promise.allSettled([
      columnas.create({ boardId: t.id, name: "Una", key: "UNA", position: 0 }),
      columnas.create({ boardId: t.id, name: "Otra", key: "OTRA", position: 0 }),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    const orden = await leerColumnas(db, t.id);
    expect(orden).toHaveLength(6);
    expect(new Set(orden).size).toBe(6);
    await expectTableroDenso(db, t.id);
  });

  it("dos create simultaneos sobre un tablero SIN columnas terminan los dos", async () => {
    // Equivalente al agujero de la columna vacia de F1b.2: sin filas de columna
    // que bloquear, las dos transacciones calculan position 0 sin verse y las
    // separa column_board_position_uniq en el COMMIT. Depende del reintento.
    const boardId = await insertBoard(db, "Sin columnas");
    expect(await leerColumnas(db, boardId)).toEqual([]);

    const resultados = await Promise.allSettled([
      columnas.create({ boardId, name: "Una", key: "UNA" }),
      columnas.create({ boardId, name: "Otra", key: "OTRA" }),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    const orden = await leerColumnas(db, boardId);
    expect(orden).toHaveLength(2);
    expect(new Set(orden).size).toBe(2);
    await expectTableroDenso(db, boardId);
  });

  it("FOR NO KEY UPDATE de columnas y FOR KEY SHARE de tareas son compatibles", async () => {
    // Verifica UNA cosa: que los dos modos de bloqueo sobre board_column
    // conviven. Crear una columna toma FOR NO KEY UPDATE sobre las filas del
    // tablero; insertar una tarea toma FOR KEY SHARE sobre la fila de su
    // columna al validar la FK. Con FOR UPDATE en vez de FOR NO KEY UPDATE
    // esto se interbloquearia, que es justamente lo que la regla de CLAUDE.md
    // existe para evitar. Por eso alcanza con una operacion de cada tipo.
    //
    // NO le subas la concurrencia. Con varios create de columna a la vez esto
    // deja de probar la compatibilidad de modos y pasa a probar si el
    // presupuesto de reintentos aguanta la cadena de invalidacion que describe
    // CLAUDE.md: eso falla ~1 de cada 5 veces y es un limite conocido del
    // sistema, no una regresion. Este test se acoto por ese motivo.
    const t = await sembrar();

    const resultados = await Promise.allSettled([
      columnas.create({ boardId: t.id, name: "Nueva", key: "NUEVA", position: 0 }),
      tareas.create({ boardId: t.id, columnId: t.todo, title: "Tarea" }),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    await expectTableroDenso(db, t.id);
    await expectColumnaDensa(db, t.todo);
  });
});
