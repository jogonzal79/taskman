import type { ListadoDeTareas } from "@taskman/contracts";
import type { BoardDetail, CorePort, Priority } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listar } from "../app/api/tasks/route.js";
import {
  connectDb,
  ctx,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * Contrato REST de GET /api/tasks (6.2, 6.3.2, RF-04).
 *
 * Mismo enfoque que el resto de la suite: el handler se importa y se invoca con un
 * `Request` armado a mano. Ver el comentario de cabecera de `boards.test.ts` para
 * el razonamiento completo, incluido el de por que cada caso usa una clave con
 * exactamente el scope que necesita.
 *
 * Las FECHAS se calculan a partir del CURRENT_DATE de PostgreSQL y no del reloj
 * del proceso. `overdue` compara contra `CURRENT_DATE`, asi que si el test armara
 * sus fechas con `new Date()` y el proceso estuviera en otra zona que la base, el
 * caso de "vence hoy" podria caer del lado equivocado y el test fallaria o pasaria
 * por la razon errada segun la hora del dia.
 */

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveWrite: string;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveRead = await emitirClave(client, ["READ"]);
  claveWrite = await emitirClave(client, ["WRITE"]);
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

const CICLO_DE_PRIORIDADES: readonly Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

/**
 * Las cuatro prioridades rotando, para sembrar un conjunto variado.
 *
 * El `??` no es defensa contra nada real —el modulo hace imposible el
 * undefined— sino `noUncheckedIndexedAccess`, que tipa todo indexado como
 * `T | undefined`. Sin el, `exactOptionalPropertyTypes` rechaza pasarlo a un
 * `priority?: Priority`.
 */
function prioridadCiclica(indice: number): Priority {
  return CICLO_DE_PRIORIDADES[indice % CICLO_DE_PRIORIDADES.length] ?? "MEDIUM";
}

/** `AAAA-MM-DD` a `dias` de distancia del CURRENT_DATE de la base. */
async function fechaRelativa(dias: number): Promise<string> {
  const filas = await client.query<{ fecha: string }>(
    `SELECT (CURRENT_DATE + ($1 || ' days')::interval)::date::text AS fecha`,
    [String(dias)],
  );
  const fecha = filas.rows[0]?.fecha;
  if (fecha === undefined) {
    throw new Error("No se pudo leer CURRENT_DATE de la base.");
  }
  return fecha;
}

/** Siembra una tarea por el nucleo, con los campos que el caso necesite. */
async function sembrarTarea(args: {
  boardId: string;
  columnKey: string;
  title: string;
  priority?: Priority;
  /** `AAAA-MM-DD`; se ancla a medianoche UTC como hace el borde. */
  dueDate?: string;
}): Promise<string> {
  const tarea = await taskman.createTask(
    {
      boardId: args.boardId,
      columnKey: args.columnKey,
      title: args.title,
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      ...(args.dueDate === undefined ? {} : { dueDate: new Date(`${args.dueDate}T00:00:00.000Z`) }),
    },
    ctx(),
  );
  return tarea.id;
}

/** Lanza el GET con la query dada y devuelve el listado ya parseado. */
async function listado(query: string, clave = claveRead): Promise<ListadoDeTareas> {
  const respuesta = await listar(peticion({ ruta: `/api/tasks?${query}`, clave }));
  expect(respuesta.status, `GET /api/tasks?${query}`).toBe(200);
  return leerJson<ListadoDeTareas>(respuesta);
}

/** Los titulos que devolvio el listado, en el orden en que vinieron. */
async function titulos(query: string): Promise<string[]> {
  return (await listado(query)).items.map((tarea) => tarea.title);
}

describe("GET /api/tasks", () => {
  describe("filtro por tablero y columna", () => {
    it("por board_id devuelve las del tablero y ninguna de otro", async () => {
      const uno = await sembrarTablero(taskman, { name: "Uno" });
      const otro = await sembrarTablero(taskman, { name: "Otro" });
      await sembrarTarea({ boardId: uno.id, columnKey: "TODO", title: "del uno" });
      await sembrarTarea({ boardId: otro.id, columnKey: "TODO", title: "del otro" });

      const cuerpo = await listado(`board_id=${uno.id}`);

      expect(cuerpo.items.map((tarea) => tarea.title)).toEqual(["del uno"]);
      expect(cuerpo.items.every((tarea) => tarea.board_id === uno.id)).toBe(true);
      expect(cuerpo.next_cursor).toBeNull();
      expect(Object.keys(cuerpo).sort()).toEqual(["items", "next_cursor"]);
    });

    it("por column_id y por column_key dan el MISMO resultado", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "en todo-0" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "en todo-1" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "DONE", title: "en done" });

      const todo = porKey(tablero, "TODO");

      const porId = await listado(`board_id=${tablero.id}&column_id=${todo}`);
      const porClave = await listado(`board_id=${tablero.id}&column_key=TODO`);

      expect(porId.items.map((tarea) => tarea.id)).toEqual(porClave.items.map((tarea) => tarea.id));
      expect(porId.items.map((tarea) => tarea.title)).toEqual(["en todo-0", "en todo-1"]);
    });

    it("column_id solo, sin board_id, alcanza: identifica la columna sola", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "en todo" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "DONE", title: "en done" });

      expect(await titulos(`column_id=${porKey(tablero, "TODO")}`)).toEqual(["en todo"]);
    });

    it("200 con lista vacia cuando el tablero no tiene tareas", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Vacio" });

      expect(await listado(`board_id=${tablero.id}`)).toEqual({ items: [], next_cursor: null });
    });

    it("404 COLUMN_NOT_FOUND con una column_key que el tablero no tiene", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}&column_key=NO_EXISTE`, clave: claveRead }),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
    });
  });

  describe("filtro por priority (repetible, OR)", () => {
    async function tableroConPrioridades(): Promise<BoardDetail> {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      for (const priority of ["LOW", "MEDIUM", "HIGH", "URGENT"] as const) {
        await sembrarTarea({
          boardId: tablero.id,
          columnKey: "TODO",
          title: `es ${priority}`,
          priority,
        });
      }
      return tablero;
    }

    it("?priority=HIGH&priority=URGENT devuelve las dos y ninguna MEDIUM ni LOW", async () => {
      const tablero = await tableroConPrioridades();

      const cuerpo = await listado(`board_id=${tablero.id}&priority=HIGH&priority=URGENT`);

      expect(cuerpo.items.map((tarea) => tarea.priority).sort()).toEqual(["HIGH", "URGENT"]);
      expect(cuerpo.items.map((tarea) => tarea.title).sort()).toEqual(["es HIGH", "es URGENT"]);
    });

    it("con una sola prioridad devuelve solo esa", async () => {
      const tablero = await tableroConPrioridades();

      expect(await titulos(`board_id=${tablero.id}&priority=LOW`)).toEqual(["es LOW"]);
    });

    it("las tres a la vez siguen siendo un OR", async () => {
      const tablero = await tableroConPrioridades();

      const cuerpo = await listado(
        `board_id=${tablero.id}&priority=LOW&priority=HIGH&priority=URGENT`,
      );

      expect(cuerpo.items.map((tarea) => tarea.priority).sort()).toEqual([
        "HIGH",
        "LOW",
        "URGENT",
      ]);
    });

    it("400 con una priority que no esta en el enum", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}&priority=CRITICAL`, clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 si UNA de varias priority es invalida: no se ignora la mala", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({
          ruta: `/api/tasks?board_id=${tablero.id}&priority=HIGH&priority=CRITICAL`,
          clave: claveRead,
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("filtro por rango de due_date", () => {
    /** Tareas en -2, 0 y +2 dias, mas una SIN fecha. */
    async function tableroConFechas(): Promise<{ tablero: BoardDetail; fechas: string[] }> {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const fechas = [await fechaRelativa(-2), await fechaRelativa(0), await fechaRelativa(2)];

      for (const fecha of fechas) {
        await sembrarTarea({
          boardId: tablero.id,
          columnKey: "TODO",
          title: `vence ${fecha}`,
          dueDate: fecha,
        });
      }
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "sin fecha" });

      return { tablero, fechas };
    }

    it("due_after es EXCLUSIVO: no devuelve la tarea que vence exactamente ese dia", async () => {
      const { tablero, fechas } = await tableroConFechas();
      const [pasada, hoy, futura] = fechas as [string, string, string];

      // El nucleo usa `due_date > X`, no `>=`: la del dia del limite queda fuera.
      expect(await titulos(`board_id=${tablero.id}&due_after=${hoy}`)).toEqual([
        `vence ${futura}`,
      ]);
      expect(await titulos(`board_id=${tablero.id}&due_after=${pasada}`)).toEqual([
        `vence ${hoy}`,
        `vence ${futura}`,
      ]);
    });

    it("due_before es EXCLUSIVO: tampoco devuelve la del dia del limite", async () => {
      const { tablero, fechas } = await tableroConFechas();
      const [pasada, hoy] = fechas as [string, string, string];

      expect(await titulos(`board_id=${tablero.id}&due_before=${hoy}`)).toEqual([
        `vence ${pasada}`,
      ]);
    });

    it("los dos juntos forman un rango abierto en los dos extremos", async () => {
      const { tablero, fechas } = await tableroConFechas();
      const [pasada, hoy, futura] = fechas as [string, string, string];

      expect(
        await titulos(`board_id=${tablero.id}&due_after=${pasada}&due_before=${futura}`),
      ).toEqual([`vence ${hoy}`]);
    });

    it("las tareas SIN due_date quedan EXCLUIDAS del rango (6.3.2)", async () => {
      const { tablero } = await tableroConFechas();
      const muyLejano = await fechaRelativa(3650);
      const muyAnterior = await fechaRelativa(-3650);

      // Un rango tan ancho que contiene todas las fechas sembradas: la unica que
      // no aparece es la que no tiene fecha. Sale de las reglas de NULL de SQL
      // —`NULL < fecha` no es verdadero— y no de una condicion escrita, asi que
      // conviene tenerlo atado.
      const cuerpo = await listado(
        `board_id=${tablero.id}&due_after=${muyAnterior}&due_before=${muyLejano}`,
      );

      expect(cuerpo.items).toHaveLength(3);
      expect(cuerpo.items.every((tarea) => tarea.due_date !== null)).toBe(true);
      expect(cuerpo.items.map((tarea) => tarea.title)).not.toContain("sin fecha");
    });

    it("sin filtro de fecha, la tarea sin due_date SI aparece", async () => {
      const { tablero } = await tableroConFechas();

      expect(await titulos(`board_id=${tablero.id}`)).toContain("sin fecha");
    });

    it("400 con un due_before que no es AAAA-MM-DD", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({
          ruta: `/api/tasks?board_id=${tablero.id}&due_before=2026-09-11T00:00:00Z`,
          clave: claveRead,
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("overdue", () => {
    it("devuelve las vencidas fuera de DONE y NO la vencida que esta en DONE", async () => {
      // El caso que decide el paso: DOS tareas vencidas, una a cada lado de la
      // condicion. Si el filtro mirara solo la fecha, las devolveria las dos.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const ayer = await fechaRelativa(-1);
      const manana = await fechaRelativa(1);

      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "vencida en TODO",
        dueDate: ayer,
      });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "DONE",
        title: "vencida en DONE",
        dueDate: ayer,
      });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "futura en TODO",
        dueDate: manana,
      });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "sin fecha" });

      const cuerpo = await listado(`board_id=${tablero.id}&overdue=true`);

      expect(cuerpo.items.map((tarea) => tarea.title)).toEqual(["vencida en TODO"]);
      expect(cuerpo.items.map((tarea) => tarea.title)).not.toContain("vencida en DONE");
    });

    it("una tarea que vence HOY no esta vencida: la comparacion es estricta", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "vence hoy",
        dueDate: await fechaRelativa(0),
      });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "vencio ayer",
        dueDate: await fechaRelativa(-1),
      });

      expect(await titulos(`board_id=${tablero.id}&overdue=true`)).toEqual(["vencio ayer"]);
    });

    it("en un tablero SIN columna DONE, una vencida aparece igual", async () => {
      // El "fuera de DONE" se resuelve por la KEY de la columna, asi que un
      // tablero sin esa key no excluye nada. Es el comportamiento correcto —no hay
      // columna terminal— y conviene tenerlo atado para que no se lea como un bug.
      const tablero = await sembrarTablero(taskman, {
        name: "Sin terminal",
        columns: [{ name: "Pendiente", key: "TODO" }],
      });

      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "vencida",
        dueDate: await fechaRelativa(-1),
      });

      expect(await titulos(`board_id=${tablero.id}&overdue=true`)).toEqual(["vencida"]);
    });

    it("lo que excluye es la KEY y no el nombre: DONE renombrada sigue excluyendo", async () => {
      // Renombrar la columna no la saca de la condicion, porque la key no se
      // puede cambiar (no esta en UpdateColumnInput) y es la key lo que se mira.
      const tablero = await sembrarTablero(taskman, {
        name: "Renombrada",
        columns: [
          { name: "Pendiente", key: "TODO" },
          { name: "Archivado", key: "DONE" },
        ],
      });

      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "DONE",
        title: "vencida en la columna renombrada",
        dueDate: await fechaRelativa(-1),
      });

      expect(await titulos(`board_id=${tablero.id}&overdue=true`)).toEqual([]);
    });

    it("overdue=false no filtra: devuelve todo", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "DONE",
        title: "vencida en DONE",
        dueDate: await fechaRelativa(-1),
      });

      expect(await titulos(`board_id=${tablero.id}&overdue=false`)).toEqual(["vencida en DONE"]);
    });

    it("400 con un overdue que no es true ni false", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}&overdue=si`, clave: claveRead }),
      );

      // Caer en false devolveria el listado completo a quien pidio solo las
      // vencidas, y no se enteraria.
      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("order_by", () => {
    /**
     * Tres tareas donde cada orden da una permutacion DISTINTA, para que ningun
     * caso pueda pasar por coincidencia: se crean en orden c, a, b; en la columna
     * quedan en ese orden; las fechas y prioridades van cruzadas.
     */
    async function tableroOrdenado(): Promise<BoardDetail> {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "primera en la columna",
        priority: "LOW",
        dueDate: await fechaRelativa(30),
      });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "segunda en la columna",
        priority: "URGENT",
        dueDate: await fechaRelativa(10),
      });
      await sembrarTarea({
        boardId: tablero.id,
        columnKey: "TODO",
        title: "tercera en la columna",
        priority: "MEDIUM",
        dueDate: await fechaRelativa(20),
      });

      return tablero;
    }

    it("position es el orden por defecto", async () => {
      const tablero = await tableroOrdenado();
      const esperado = [
        "primera en la columna",
        "segunda en la columna",
        "tercera en la columna",
      ];

      expect(await titulos(`board_id=${tablero.id}`)).toEqual(esperado);
      expect(await titulos(`board_id=${tablero.id}&order_by=position`)).toEqual(esperado);
    });

    it("due_date ordena de la mas proxima a la mas lejana, y las SIN fecha van al final", async () => {
      const tablero = await tableroOrdenado();
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "sin fecha" });

      // NULLS LAST: a diferencia del filtro de rango, ordenar por fecha NO excluye
      // las que no tienen, las manda al final.
      expect(await titulos(`board_id=${tablero.id}&order_by=due_date`)).toEqual([
        "segunda en la columna",
        "tercera en la columna",
        "primera en la columna",
        "sin fecha",
      ]);
    });

    it("priority ordena URGENT primero y LOW ultimo", async () => {
      const tablero = await tableroOrdenado();

      // DESC sobre el enum, y el enum esta declarado LOW, MEDIUM, HIGH, URGENT:
      // PostgreSQL ordena los enum por su orden de declaracion, no alfabetico.
      expect(await titulos(`board_id=${tablero.id}&order_by=priority`)).toEqual([
        "segunda en la columna",
        "tercera en la columna",
        "primera en la columna",
      ]);
    });

    it("priority es ESTABLE entre tareas de la misma prioridad", async () => {
      // El desempate es `id ASC`, que no cambia nunca, asi que dos llamadas dan el
      // mismo orden y la paginacion no puede repetir ni saltear.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      for (let i = 0; i < 6; i += 1) {
        await sembrarTarea({
          boardId: tablero.id,
          columnKey: "TODO",
          title: `igual-${i}`,
          priority: "HIGH",
        });
      }

      const primera = await listado(`board_id=${tablero.id}&order_by=priority`);
      const segunda = await listado(`board_id=${tablero.id}&order_by=priority`);

      expect(segunda.items.map((tarea) => tarea.id)).toEqual(primera.items.map((tarea) => tarea.id));
      // Y el orden es el de los ids, que es el desempate declarado.
      expect(primera.items.map((tarea) => tarea.id)).toEqual(
        [...primera.items.map((tarea) => tarea.id)].sort(),
      );
    });

    it("created_at ordena de la mas reciente a la mas vieja", async () => {
      const tablero = await tableroOrdenado();

      // DESC: lo ultimo creado primero. Es el reverso del orden de creacion.
      expect(await titulos(`board_id=${tablero.id}&order_by=created_at`)).toEqual([
        "tercera en la columna",
        "segunda en la columna",
        "primera en la columna",
      ]);
    });

    it("400 con un order_by que no esta en la 6.3.2", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}&order_by=title`, clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con order_by en camelCase: el borde habla snake_case (6.1)", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}&order_by=dueDate`, clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("paginacion por cursor (6.1)", () => {
    /** Recorre todas las paginas y devuelve los ids en el orden en que salieron. */
    async function recorrer(query: string, limit: number): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | null = null;
      let vueltas = 0;

      do {
        const sufijo = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const pagina: ListadoDeTareas = await listado(`${query}&limit=${limit}${sufijo}`);

        expect(pagina.items.length, "ninguna pagina puede exceder el limit").toBeLessThanOrEqual(
          limit,
        );
        ids.push(...pagina.items.map((tarea) => tarea.id));
        cursor = pagina.next_cursor;

        vueltas += 1;
        expect(vueltas, "la paginacion no termina").toBeLessThan(20);
      } while (cursor !== null);

      return ids;
    }

    it("la primera pagina trae limit items y un next_cursor; la segunda continua", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const esperados: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        esperados.push(
          await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: `t-${i}` }),
        );
      }

      const primera = await listado(`board_id=${tablero.id}&limit=3`);

      expect(primera.items).toHaveLength(3);
      expect(primera.next_cursor).not.toBeNull();
      expect(primera.items.map((tarea) => tarea.title)).toEqual(["t-0", "t-1", "t-2"]);

      const segunda = await listado(
        `board_id=${tablero.id}&limit=3&cursor=${encodeURIComponent(primera.next_cursor ?? "")}`,
      );

      expect(segunda.items.map((tarea) => tarea.title)).toEqual(["t-3", "t-4", "t-5"]);
      // Sin repetir ninguna de la primera pagina.
      const idsPrimera = new Set(primera.items.map((tarea) => tarea.id));
      expect(segunda.items.some((tarea) => idsPrimera.has(tarea.id))).toBe(false);

      const tercera = await listado(
        `board_id=${tablero.id}&limit=3&cursor=${encodeURIComponent(segunda.next_cursor ?? "")}`,
      );

      expect(tercera.items.map((tarea) => tarea.title)).toEqual(["t-6"]);
      // Ultima pagina: next_cursor en null, nunca ausente.
      expect(tercera.next_cursor).toBeNull();

      // La union de las paginas es EXACTAMENTE el conjunto esperado: ni repetidas
      // ni salteadas.
      const recorrido = [
        ...primera.items,
        ...segunda.items,
        ...tercera.items,
      ].map((tarea) => tarea.id);

      expect(recorrido).toEqual(esperados);
      expect(new Set(recorrido).size).toBe(esperados.length);
    });

    it("el recorrido completo es el conjunto exacto con cada order_by", async () => {
      // La paginacion keyset depende del orden: un cursor mal armado para alguno de
      // los ordenes repetiria o saltearia filas, y con `due_date` ademas hay nulos
      // en el medio.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const esperados = new Set<string>();

      for (let i = 0; i < 9; i += 1) {
        esperados.add(
          await sembrarTarea({
            boardId: tablero.id,
            columnKey: "TODO",
            title: `t-${i}`,
            priority: prioridadCiclica(i),
            // Una de cada tres sin fecha, para que `due_date` pagine sobre nulos.
            ...(i % 3 === 0 ? {} : { dueDate: await fechaRelativa(i) }),
          }),
        );
      }

      for (const orden of ["position", "due_date", "priority", "created_at"]) {
        const ids = await recorrer(`board_id=${tablero.id}&order_by=${orden}`, 2);

        expect(new Set(ids), `order_by=${orden} perdio o repitio filas`).toEqual(esperados);
        expect(ids.length, `order_by=${orden} devolvio duplicados`).toBe(esperados.size);
      }
    });

    it("un cursor invalido se IGNORA y devuelve la primera pagina", async () => {
      // Comportamiento heredado del nucleo: `decodificarCursor` devuelve undefined
      // ante cualquier cosa que no decodifique, y la condicion no se aplica. Es el
      // mismo de GET /api/boards. Queda atado para que el dia que se decida que
      // tiene que ser un 400, el cambio se note acá y no en produccion.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      for (let i = 0; i < 3; i += 1) {
        await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: `t-${i}` });
      }

      const cuerpo = await listado(`board_id=${tablero.id}&cursor=no-es-un-cursor`);

      expect(cuerpo.items.map((tarea) => tarea.title)).toEqual(["t-0", "t-1", "t-2"]);
    });
  });

  describe("validacion y autorizacion", () => {
    it("400 sin board_id ni column_id (6.3.2)", async () => {
      // El nucleo sin filtros devolveria las tareas de TODOS los tableros; la regla
      // de la 6.3.2 la sostiene el borde.
      const respuesta = await listar(peticion({ ruta: "/api/tasks", clave: claveRead }));

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con column_key pero sin board_id: la key se resuelve dentro de un tablero", async () => {
      const respuesta = await listar(
        peticion({ ruta: "/api/tasks?column_key=TODO", clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con limit fuera de rango o no numerico", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      for (const limit of ["0", "201", "abc", "-1", "1.5"]) {
        const respuesta = await listar(
          peticion({ ruta: `/api/tasks?board_id=${tablero.id}&limit=${limit}`, clave: claveRead }),
        );

        expect(respuesta.status, `limit=${limit} deberia ser 400`).toBe(400);
        expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("200 con el limit en los bordes del rango de la 6.1", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      expect((await listado(`board_id=${tablero.id}&limit=1`)).items).toHaveLength(0);
      expect((await listado(`board_id=${tablero.id}&limit=200`)).items).toHaveLength(0);
    });

    it("400 con un board_id que no es UUID", async () => {
      const respuesta = await listar(
        peticion({ ruta: "/api/tasks?board_id=no-soy-un-uuid", clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("401 sin la cabecera Authorization", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(peticion({ ruta: `/api/tasks?board_id=${tablero.id}` }));

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    });

    it("403 con una clave sin scope read", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await listar(
        peticion({ ruta: `/api/tasks?board_id=${tablero.id}`, clave: claveWrite }),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "read",
        granted_scopes: ["write"],
      });
    });
  });
});
