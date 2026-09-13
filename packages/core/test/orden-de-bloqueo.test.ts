import { prisma } from "@taskman/db";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TaskRepository, TaskService, TransactionRunner } from "../src/index";
import {
  connectDb,
  ctx,
  insertBoard,
  insertColumn,
  insertTasks,
  truncateAll,
} from "./helpers";

/**
 * EL DETECTOR DE REGRESION DEL ORDEN DE BLOQUEO DE LA 5.4.
 *
 * No corre en `verify` y no es un descuido: tarda ~50 s, que no se pagan en una
 * suite que corre en cada paso. Se invoca a mano:
 *
 *     pnpm --filter @taskman/core run test:orden-de-bloqueo
 *
 * POR QUE EXISTE APARTE DE C2. Un interbloqueo entre dos movimientos cruzados
 * no es determinista: depende de que las dos transacciones se entrelacen dentro
 * de la ventana de una sola sentencia, que dura milisegundos. Medido rompiendo
 * el orden a proposito —ordenando la columna de ORIGEN primero, que es distinto
 * para cada movimiento, en vez del `column_id, id` que es igual para todos—:
 *
 *     orden canonico (column_id, id)   0 interbloqueos en 200 rondas
 *     orden roto (origen primero)      3 en 300 rondas  (~1% por ronda)
 *
 * Con ~1% por ronda, las 5 rondas de C2 atrapan esa regresion cerca del 5% de
 * las veces. C2 no es inestable —con el codigo correcto da 0 interbloqueos
 * siempre— es INSENSIBLE, que es otra cosa y no se nota mirandolo. Con 460
 * rondas la deteccion sube a ~99%.
 *
 * COMO SE DISTINGUEN LOS DOS REGIMENES. Un interbloqueo sale con la firma del
 * `deadlock_timeout` de PostgreSQL, 1 s por defecto: la ronda que lo sufre tarda
 * ~1150 ms contra los ~150 ms de la mas lenta sin el. Y no puede confundirse con
 * un reintento: 40P01 queda deliberadamente fuera de `isRetryableConflict`, asi
 * que un interbloqueo sube como rechazo y nunca se absorbe.
 */

const CORRER = process.env["TASKMAN_ORDEN_DE_BLOQUEO"] === "1";

/** ~99% de deteccion con la tasa medida del 1% por ronda. */
const RONDAS = 460;

describe.skipIf(!CORRER)("orden de bloqueo de la 5.4 (alta cardinalidad)", () => {
  let db: Client;
  let servicio: TaskService;

  beforeAll(async () => {
    db = await connectDb();
    servicio = new TaskService(new TaskRepository(new TransactionRunner(prisma)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.end();
  });

  it(`${RONDAS} rondas de movimientos cruzados sin un solo interbloqueo`, async () => {
    let interbloqueos = 0;
    let otrosFallos = 0;
    const motivos = new Set<string>();
    let rondaMasLenta = 0;

    for (let ronda = 0; ronda < RONDAS; ronda += 1) {
      await truncateAll(db);
      const boardId = await insertBoard(db);
      const todo = await insertColumn(db, { boardId, key: "todo", position: 0 });
      const doing = await insertColumn(db, { boardId, key: "doing", position: 1 });
      const enTodo = await insertTasks(db, {
        boardId,
        columnId: todo,
        prefijo: "todo",
        cantidad: 3,
      });
      const enDoing = await insertTasks(db, {
        boardId,
        columnId: doing,
        prefijo: "doing",
        cantidad: 3,
      });

      const inicio = performance.now();
      const resultados = await Promise.allSettled([
        servicio.move(enTodo[0] as string, { columnId: doing, position: 0 }, ctx()),
        servicio.move(enDoing[0] as string, { columnId: todo, position: 0 }, ctx()),
      ]);
      rondaMasLenta = Math.max(rondaMasLenta, performance.now() - inicio);

      for (const resultado of resultados) {
        if (resultado.status !== "rejected") {
          continue;
        }
        const texto = String(resultado.reason).replace(/\s+/g, " ");
        if (texto.includes("40P01") || texto.toLowerCase().includes("deadlock")) {
          interbloqueos += 1;
        } else {
          otrosFallos += 1;
        }
        motivos.add(texto.slice(0, 200));
      }
    }

    // La medicion queda a la vista: este test se corre a mano y lo que importa
    // no es solo que pase, sino con cuanto margen.
    console.log(
      [
        ``,
        `  rondas:          ${RONDAS}`,
        `  interbloqueos:   ${interbloqueos}`,
        `  otros fallos:    ${otrosFallos}`,
        `  ronda mas lenta: ${rondaMasLenta.toFixed(1)} ms   (deadlock_timeout = 1000 ms)`,
        ...[...motivos].map((motivo) => `  MOTIVO: ${motivo}`),
      ].join("\n"),
    );

    expect(interbloqueos).toBe(0);
    expect(otrosFallos).toBe(0);
    // Si alguna ronda se acerco al segundo, hubo espera de interbloqueo aunque
    // PostgreSQL la haya resuelto sin abortar a nuestras transacciones.
    expect(rondaMasLenta).toBeLessThan(900);
  }, 600_000);
});
