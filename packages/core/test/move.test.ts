import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError, TaskRepository, TaskService } from "../src/index.js";
import {
  connectDb,
  expectColumnaDensa,
  insertBoard,
  insertColumn,
  insertTasks,
  leerOrden,
  truncateAll,
  uuid,
} from "./helpers.js";

let db: Client;
let servicio: TaskService;

beforeAll(async () => {
  db = await connectDb();
  servicio = new TaskService(new TaskRepository(prisma));
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

interface Tablero {
  boardId: string;
  todo: string;
  doing: string;
  tareasTodo: string[];
  tareasDoing: string[];
}

/** Dos columnas: `todo` con 3 tareas y `doing` con 2. */
async function sembrar(): Promise<Tablero> {
  const boardId = await insertBoard(db);
  const todo = await insertColumn(db, { boardId, key: "todo", position: 0 });
  const doing = await insertColumn(db, { boardId, key: "doing", position: 1 });

  return {
    boardId,
    todo,
    doing,
    tareasTodo: await insertTasks(db, { boardId, columnId: todo, prefijo: "todo", cantidad: 3 }),
    tareasDoing: await insertTasks(db, { boardId, columnId: doing, prefijo: "doing", cantidad: 2 }),
  };
}

/** Captura el DomainError esperado; re-lanza cualquier otra cosa. */
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

describe("mover entre columnas", () => {
  it("inserta en la posicion pedida y compacta la columna de origen", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];
    const [d0, d1] = t.tareasDoing as [string, string];

    const resultado = await servicio.move(segunda, { columnId: t.doing, position: 1 });

    expect(resultado.fromColumnId).toBe(t.todo);
    expect(resultado.toColumnId).toBe(t.doing);
    expect(resultado.task.columnId).toBe(t.doing);
    expect(resultado.task.position).toBe(1);

    // El orden devuelto es el autoritativo de la base.
    expect(resultado.affectedColumns).toEqual([
      { columnId: t.todo, taskOrder: [primera, tercera] },
      { columnId: t.doing, taskOrder: [d0, segunda, d1] },
    ]);
    expect(await leerOrden(db, t.todo)).toEqual([primera, tercera]);
    expect(await leerOrden(db, t.doing)).toEqual([d0, segunda, d1]);

    await expectColumnaDensa(db, t.todo);
    await expectColumnaDensa(db, t.doing);
  });

  it("mueve a una columna vacia", async () => {
    const t = await sembrar();
    const vacia = await insertColumn(db, { boardId: t.boardId, key: "done", position: 2 });
    const [primera] = t.tareasTodo as [string, string, string];

    const resultado = await servicio.move(primera, { columnId: vacia, position: 0 });

    expect(resultado.task.position).toBe(0);
    expect(await leerOrden(db, vacia)).toEqual([primera]);
    await expectColumnaDensa(db, t.todo);
    await expectColumnaDensa(db, vacia);
  });
});

describe("C3: mover dentro de la misma columna", () => {
  it("hacia adelante deja el orden denso", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];

    const resultado = await servicio.move(primera, { columnId: t.todo, position: 2 });

    expect(resultado.fromColumnId).toBe(t.todo);
    expect(resultado.toColumnId).toBe(t.todo);
    // Una sola columna afectada: no es una rama distinta del algoritmo, es el
    // mismo calculo con origen igual a destino.
    expect(resultado.affectedColumns).toEqual([
      { columnId: t.todo, taskOrder: [segunda, tercera, primera] },
    ]);
    expect(resultado.task.position).toBe(2);
    await expectColumnaDensa(db, t.todo);
  });

  it("hacia atras deja el orden denso", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];

    const resultado = await servicio.move(tercera, { columnId: t.todo, position: 0 });

    expect(resultado.affectedColumns).toEqual([
      { columnId: t.todo, taskOrder: [tercera, primera, segunda] },
    ]);
    expect(resultado.task.position).toBe(0);
    await expectColumnaDensa(db, t.todo);
  });
});

describe("C4: end y una posicion mayor que la columna", () => {
  it("dan el mismo resultado", async () => {
    const t = await sembrar();
    const [primera, segunda] = t.tareasTodo as [string, string, string];

    const conLiteral = await servicio.move(primera, { columnId: t.doing, position: "end" });
    const conDesborde = await servicio.move(segunda, { columnId: t.doing, position: 999 });

    // Las dos quedaron al final, en el orden en que se pidieron.
    expect(conLiteral.task.position).toBe(2);
    expect(conDesborde.task.position).toBe(3);
    expect(await leerOrden(db, t.doing)).toEqual([...t.tareasDoing, primera, segunda]);
    await expectColumnaDensa(db, t.doing);
  });

  it("sobre una misma columna, end y una posicion desbordada coinciden", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const conDesborde = await servicio.move(primera, { columnId: t.doing, position: 999 });
    const ordenDesborde = await leerOrden(db, t.doing);

    // Se rehace la misma jugada desde cero, ahora con el literal.
    await truncateAll(db);
    const u = await sembrar();
    const [primeraU] = u.tareasTodo as [string, string, string];
    const conLiteral = await servicio.move(primeraU, { columnId: u.doing, position: "end" });
    const ordenLiteral = await leerOrden(db, u.doing);

    expect(conDesborde.task.position).toBe(conLiteral.task.position);
    expect(ordenDesborde.indexOf(primera)).toBe(ordenLiteral.indexOf(primeraU));
    await expectColumnaDensa(db, u.doing);
  });
});

describe("errores de dominio", () => {
  it("TASK_NOT_FOUND si la tarea no existe", async () => {
    const t = await sembrar();
    const inexistente = uuid();

    const error = await capturarDominio(() =>
      servicio.move(inexistente, { columnId: t.doing, position: 0 }),
    );

    expect(error.code).toBe("TASK_NOT_FOUND");
    expect(error.details).toEqual({ taskId: inexistente });
    // Nada se movio.
    expect(await leerOrden(db, t.doing)).toEqual(t.tareasDoing);
  });

  it("COLUMN_NOT_FOUND si la columna destino no existe", async () => {
    const t = await sembrar();
    const inexistente = uuid();
    const [primera] = t.tareasTodo as [string, string, string];

    const error = await capturarDominio(() =>
      servicio.move(primera, { columnId: inexistente, position: 0 }),
    );

    expect(error.code).toBe("COLUMN_NOT_FOUND");
    expect(error.details).toEqual({ columnId: inexistente });
    expect(await leerOrden(db, t.todo)).toEqual(t.tareasTodo);
  });

  it("COLUMN_NOT_IN_BOARD si la columna destino es de otro tablero", async () => {
    const t = await sembrar();
    const otroBoard = await insertBoard(db, "Otro");
    const ajena = await insertColumn(db, { boardId: otroBoard, key: "todo", position: 0 });
    const [primera] = t.tareasTodo as [string, string, string];

    const error = await capturarDominio(() =>
      servicio.move(primera, { columnId: ajena, position: 0 }),
    );

    expect(error.code).toBe("COLUMN_NOT_IN_BOARD");
    expect(error.details).toMatchObject({
      taskId: primera,
      columnId: ajena,
      taskBoardId: t.boardId,
      columnBoardId: otroBoard,
    });
    expect(error.hint).toBeDefined();
    expect(await leerOrden(db, t.todo)).toEqual(t.tareasTodo);
  });

  it("INVALID_ORDER si la posicion es negativa", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const error = await capturarDominio(() =>
      servicio.move(primera, { columnId: t.doing, position: -1 }),
    );

    expect(error.code).toBe("INVALID_ORDER");
    expect(error.details).toEqual({ taskId: primera, position: -1 });
    expect(await leerOrden(db, t.todo)).toEqual(t.tareasTodo);
  });

  it("INVALID_ORDER si la posicion no es entera", async () => {
    const t = await sembrar();
    const [primera] = t.tareasTodo as [string, string, string];

    const error = await capturarDominio(() =>
      servicio.move(primera, { columnId: t.doing, position: 1.5 }),
    );

    expect(error.code).toBe("INVALID_ORDER");
  });
});

describe("concurrencia", () => {
  it("C1: dos movimientos simultaneos a la misma posicion terminan los dos", async () => {
    const t = await sembrar();
    const [primera, segunda] = t.tareasTodo as [string, string, string];

    const resultados = await Promise.allSettled([
      servicio.move(primera, { columnId: t.doing, position: 0 }),
      servicio.move(segunda, { columnId: t.doing, position: 0 }),
    ]);

    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

    const orden = await leerOrden(db, t.doing);
    // Las dos llegaron, sin duplicados, y el orden quedo denso.
    expect(orden).toHaveLength(4);
    expect(new Set(orden).size).toBe(4);
    expect(orden).toContain(primera);
    expect(orden).toContain(segunda);
    await expectColumnaDensa(db, t.doing);
    await expectColumnaDensa(db, t.todo);
  });

  it("C2: movimientos cruzados A->B y B->A no se interbloquean", async () => {
    // Varias rondas: un interbloqueo depende del entrelazado, y una sola ronda
    // podria pasar por casualidad aun con un orden de bloqueo incorrecto.
    for (let ronda = 0; ronda < 5; ronda += 1) {
      await truncateAll(db);
      const t = await sembrar();
      const [deTodo] = t.tareasTodo as [string, string, string];
      const [deDoing] = t.tareasDoing as [string, string];

      const resultados = await Promise.allSettled([
        servicio.move(deTodo, { columnId: t.doing, position: 0 }),
        servicio.move(deDoing, { columnId: t.todo, position: 0 }),
      ]);

      const motivos = resultados
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason));
      // Un 40P01 (deadlock_detected) apareceria aca con nombre y apellido.
      expect(motivos).toEqual([]);

      expect(await leerOrden(db, t.doing)).toContain(deTodo);
      expect(await leerOrden(db, t.todo)).toContain(deDoing);
      await expectColumnaDensa(db, t.todo);
      await expectColumnaDensa(db, t.doing);
    }
  });

  it("dos move simultaneos hacia una columna VACIA terminan los dos", async () => {
    // Mismo agujero que en create, por la misma razon: la columna destino no
    // tiene filas que bloquear. Lo cubre el reintento ante
    // task_column_position_uniq, no el orden de bloqueo.
    const t = await sembrar();
    const vacia = await insertColumn(db, { boardId: t.boardId, key: "done", position: 2 });
    const [deTodo] = t.tareasTodo as [string, string, string];
    const [deDoing] = t.tareasDoing as [string, string];

    const resultados = await Promise.allSettled([
      servicio.move(deTodo, { columnId: vacia, position: 0 }),
      servicio.move(deDoing, { columnId: vacia, position: 0 }),
    ]);

    const motivos = resultados
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    expect(motivos).toEqual([]);

    const orden = await leerOrden(db, vacia);
    expect(orden).toHaveLength(2);
    expect(new Set(orden).size).toBe(2);
    expect(orden).toContain(deTodo);
    expect(orden).toContain(deDoing);
    await expectColumnaDensa(db, vacia);
  });

  it("C5: una rafaga hacia la misma columna deja el orden denso", async () => {
    const t = await sembrar();
    const [primera, segunda, tercera] = t.tareasTodo as [string, string, string];

    const resultados = await Promise.allSettled([
      servicio.move(primera, { columnId: t.doing, position: 0 }),
      servicio.move(segunda, { columnId: t.doing, position: 1 }),
      servicio.move(tercera, { columnId: t.doing, position: "end" }),
    ]);

    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);

    const orden = await leerOrden(db, t.doing);
    expect(orden).toHaveLength(5);
    expect(new Set(orden).size).toBe(5);
    expect(await leerOrden(db, t.todo)).toEqual([]);
    await expectColumnaDensa(db, t.doing);
  });
});
