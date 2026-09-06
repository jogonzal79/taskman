import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  connectDb,
  countRows,
  expectDbFailure,
  insertBoard,
  insertColumn,
  insertTask,
  truncateAll,
} from "./helpers.js";

// SQLSTATE de PostgreSQL que usamos en las aserciones.
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

let db: Client;

beforeAll(async () => {
  db = await connectDb();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  // Si un test anterior dejo una transaccion abortada, la cerramos antes de
  // limpiar. Fuera de transaccion, ROLLBACK solo emite un aviso.
  await db.query("ROLLBACK").catch(() => undefined);
  await truncateAll(db);
});

describe("restricciones diferidas de position", () => {
  it("T1: intercambia dos posiciones en una transaccion sin estado intermedio valido", async () => {
    const boardId = await insertBoard(db);
    const columnId = await insertColumn(db, { boardId, key: "todo", position: 0 });
    const first = await insertTask(db, { boardId, columnId, title: "Primera", position: 0 });
    const second = await insertTask(db, { boardId, columnId, title: "Segunda", position: 1 });

    // Sin DEFERRABLE INITIALLY DEFERRED el swap de abajo no probaria nada.
    const declaration = await db.query<{ condeferrable: boolean; condeferred: boolean }>(
      "SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'task_column_position_uniq'",
    );
    expect(declaration.rows[0]).toEqual({ condeferrable: true, condeferred: true });

    await db.query("BEGIN");
    // Tras este UPDATE hay dos tareas en position = 1: estado invalido.
    await db.query("UPDATE task SET position = 1 WHERE id = $1", [first]);
    await db.query("UPDATE task SET position = 0 WHERE id = $1", [second]);
    await db.query("COMMIT");

    const order = await db.query<{ id: string; position: number }>(
      "SELECT id, position FROM task WHERE column_id = $1 ORDER BY position",
      [columnId],
    );
    expect(order.rows).toEqual([
      { id: second, position: 0 },
      { id: first, position: 1 },
    ]);

    // Evidencia de que el estado intermedio es realmente invalido: la misma
    // primera sentencia, con la restriccion en modo IMMEDIATE, es rechazada.
    await db.query("BEGIN");
    await db.query("SET CONSTRAINTS task_column_position_uniq IMMEDIATE");
    const immediateFailure = await expectDbFailure(() =>
      db.query("UPDATE task SET position = 1 WHERE id = $1", [second]),
    );
    expect(immediateFailure.code).toBe(UNIQUE_VIOLATION);
    expect(immediateFailure.constraint).toBe("task_column_position_uniq");
    await db.query("ROLLBACK");
  });

  it("T2: dos tareas con la misma position fallan, y fallan en el COMMIT", async () => {
    const boardId = await insertBoard(db);
    const columnId = await insertColumn(db, { boardId, key: "todo", position: 0 });
    await insertTask(db, { boardId, columnId, title: "Primera", position: 0 });
    const second = await insertTask(db, { boardId, columnId, title: "Segunda", position: 1 });

    await db.query("BEGIN");

    // El UPDATE que rompe la unicidad tiene que pasar sin error: la
    // comprobacion esta diferida hasta el final de la transaccion.
    await expect(
      db.query("UPDATE task SET position = 0 WHERE id = $1", [second]),
    ).resolves.toBeDefined();

    const failure = await expectDbFailure(() => db.query("COMMIT"));
    expect(failure.code).toBe(UNIQUE_VIOLATION);
    expect(failure.constraint).toBe("task_column_position_uniq");

    // El COMMIT fallido aborta la transaccion: no quedo nada escrito.
    const positions = await db.query<{ position: number }>(
      "SELECT position FROM task WHERE column_id = $1 ORDER BY position",
      [columnId],
    );
    expect(positions.rows).toEqual([{ position: 0 }, { position: 1 }]);
  });
});

describe("integridad entre tablero y columna", () => {
  it("T3: rechaza una tarea cuya columna pertenece a otro tablero", async () => {
    const boardA = await insertBoard(db, "Tablero A");
    const boardB = await insertBoard(db, "Tablero B");
    const columnOfB = await insertColumn(db, { boardId: boardB, key: "todo", position: 0 });

    const failure = await expectDbFailure(() =>
      insertTask(db, { boardId: boardA, columnId: columnOfB, title: "Cruzada", position: 0 }),
    );

    expect(failure.code).toBe(FOREIGN_KEY_VIOLATION);
    expect(failure.constraint).toBe("task_column_same_board");
    expect(await countRows(db, "task")).toBe(0);
  });

  it("T4: borrar un tablero arrastra sus columnas y tareas", async () => {
    const boardId = await insertBoard(db, "A borrar");
    const todo = await insertColumn(db, { boardId, key: "todo", position: 0 });
    const doing = await insertColumn(db, { boardId, key: "doing", position: 1 });
    await insertTask(db, { boardId, columnId: todo, title: "Uno", position: 0 });
    await insertTask(db, { boardId, columnId: todo, title: "Dos", position: 1 });
    await insertTask(db, { boardId, columnId: doing, title: "Tres", position: 0 });

    // Un segundo tablero que no debe verse afectado.
    const survivor = await insertBoard(db, "Sobreviviente");
    const survivorColumn = await insertColumn(db, { boardId: survivor, key: "todo", position: 0 });
    await insertTask(db, { boardId: survivor, columnId: survivorColumn, title: "Intacta", position: 0 });

    // Con ON DELETE RESTRICT en task -> board_column esto fallaria: RESTRICT se
    // evalua fila a fila e ignora que la tarea tambien la borra la cascada.
    await expect(db.query("DELETE FROM board WHERE id = $1", [boardId])).resolves.toBeDefined();

    expect(await countRows(db, "board")).toBe(1);
    expect(await countRows(db, "board_column")).toBe(1);
    expect(await countRows(db, "task")).toBe(1);

    const remaining = await db.query<{ board_id: string }>("SELECT board_id FROM task");
    expect(remaining.rows).toEqual([{ board_id: survivor }]);
  });

  it("T5: rechaza borrar una columna que todavia tiene tareas", async () => {
    const boardId = await insertBoard(db);
    const columnId = await insertColumn(db, { boardId, key: "todo", position: 0 });
    await insertTask(db, { boardId, columnId, title: "Bloqueante", position: 0 });

    const failure = await expectDbFailure(() =>
      db.query("DELETE FROM board_column WHERE id = $1", [columnId]),
    );

    expect(failure.code).toBe(FOREIGN_KEY_VIOLATION);
    // Dos FK protegen la columna. Postgres informa la que se creo primero
    // (task_column_id_fkey); aceptamos cualquiera de las dos para que el test
    // siga siendo valido si cambia el orden de creacion.
    expect(["task_column_id_fkey", "task_column_same_board"]).toContain(failure.constraint);

    expect(await countRows(db, "board_column")).toBe(1);
    expect(await countRows(db, "task")).toBe(1);
  });
});

describe("CHECK y unicidad de datos", () => {
  it("T6: rechaza position negativa y titulo en blanco", async () => {
    const boardId = await insertBoard(db);
    const columnId = await insertColumn(db, { boardId, key: "todo", position: 0 });

    const negativePosition = await expectDbFailure(() =>
      insertTask(db, { boardId, columnId, title: "Valida", position: -1 }),
    );
    expect(negativePosition.code).toBe(CHECK_VIOLATION);
    expect(negativePosition.constraint).toBe("task_position_nonneg");

    const emptyTitle = await expectDbFailure(() =>
      insertTask(db, { boardId, columnId, title: "", position: 0 }),
    );
    expect(emptyTitle.code).toBe(CHECK_VIOLATION);
    expect(emptyTitle.constraint).toBe("task_title_not_blank");

    // Solo espacios. Ojo: el CHECK usa btrim(title) sin conjunto de caracteres,
    // y btrim recorta unicamente espacios, no tabs ni saltos de linea.
    const blankTitle = await expectDbFailure(() =>
      insertTask(db, { boardId, columnId, title: "     ", position: 0 }),
    );
    expect(blankTitle.code).toBe(CHECK_VIOLATION);
    expect(blankTitle.constraint).toBe("task_title_not_blank");

    expect(await countRows(db, "task")).toBe(0);
  });

  it("T7: la key de columna es unica por tablero, no globalmente", async () => {
    const boardA = await insertBoard(db, "Tablero A");
    const boardB = await insertBoard(db, "Tablero B");
    await insertColumn(db, { boardId: boardA, key: "todo", position: 0 });

    const duplicate = await expectDbFailure(() =>
      insertColumn(db, { boardId: boardA, key: "todo", position: 1 }),
    );
    expect(duplicate.code).toBe(UNIQUE_VIOLATION);
    expect(duplicate.constraint).toBe("board_column_board_id_key_key");

    // La misma key en otro tablero es perfectamente valida.
    await expect(
      insertColumn(db, { boardId: boardB, key: "todo", position: 0 }),
    ).resolves.toBeTypeOf("string");
    expect(await countRows(db, "board_column")).toBe(2);
  });
});

describe("indice de busqueda de texto", () => {
  it("T8: encuentra tareas por titulo y por descripcion con to_tsvector en espaniol", async () => {
    const boardId = await insertBoard(db);
    const columnId = await insertColumn(db, { boardId, key: "todo", position: 0 });

    const byTitle = await insertTask(db, {
      boardId,
      columnId,
      title: "Refactorizar el modulo de facturas",
      description: "Sin novedades por ahora",
      position: 0,
    });
    const byDescription = await insertTask(db, {
      boardId,
      columnId,
      title: "Pulir la pantalla de ajustes",
      description: "Revisar los adjuntos del comprobante",
      position: 1,
    });

    const index = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'task' AND indexname = 'task_search_idx'",
    );
    expect(index.rows[0]?.indexdef).toContain("gin");

    const search = async (term: string): Promise<string[]> => {
      const result = await db.query<{ id: string }>(
        `SELECT id
           FROM task
          WHERE to_tsvector('spanish', title || ' ' || coalesce(description, ''))
                @@ plainto_tsquery('spanish', $1)
          ORDER BY position`,
        [term],
      );
      return result.rows.map((row) => row.id);
    };

    // "factura" en singular encuentra "facturas": el stemmer en espaniol reduce
    // ambas a la misma raiz.
    expect(await search("factura")).toEqual([byTitle]);
    expect(await search("adjunto")).toEqual([byDescription]);
    expect(await search("inexistente")).toEqual([]);
  });
});
