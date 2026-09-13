import type { Tarea } from "@taskman/contracts";
import type { BoardDetail, CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as obtener } from "../app/api/tasks/[id]/route";
import { POST as crearTarea } from "../app/api/tasks/route";
import {
  connectDb,
  contarFilas,
  contextoDeRuta,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  sembrarTareas,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de POST /api/tasks y GET /api/tasks/{id} (6.2 y 6.3.1).
 *
 * Mismo enfoque que el resto de la suite: los handlers se importan y se invocan
 * con un `Request` armado a mano. Ver el comentario de cabecera de
 * `boards.test.ts` para el razonamiento completo, incluido el de por que cada
 * caso usa una clave con exactamente el scope que necesita.
 *
 * El ORDEN de la columna se comprueba por SQL y nunca por la respuesta, que
 * ademas no lo trae: POST /api/tasks devuelve la tarea sola, como escribe la
 * 6.3.1.
 */

/** Las claves de `tarea` (contracts), los campos de la 6.3.1. */
const CLAVES_TAREA = [
  "board_id",
  "column_id",
  "created_at",
  "description",
  "due_date",
  "id",
  "position",
  "priority",
  "title",
  "updated_at",
];

const UUID_INEXISTENTE = "11111111-2222-4333-8444-555555555555";

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

/** Los titulos de las tareas de una columna, en orden de position. */
async function titulosPorPosicion(columnId: string): Promise<string[]> {
  const filas = await client.query<{ title: string }>(
    `SELECT title FROM task WHERE column_id = $1::uuid ORDER BY position`,
    [columnId],
  );
  return filas.rows.map((fila) => fila.title);
}

/** El orden de tareas de la columna es exactamente 0..n-1 (ADR-004). */
async function expectColumnaDensa(columnId: string): Promise<void> {
  const filas = await client.query<{ position: number }>(
    `SELECT position FROM task WHERE column_id = $1::uuid ORDER BY position`,
    [columnId],
  );
  const posiciones = filas.rows.map((fila) => fila.position);
  expect(posiciones).toEqual(posiciones.map((_, indice) => indice));
}

/**
 * La fila de `task` leida de la base. `due_date::text` es lo que PostgreSQL tiene
 * guardado de verdad, sin que lo toque ningun driver ni ninguna zona horaria: es
 * la unica forma de comprobar la fecha sin que la comprobacion herede el mismo
 * error que querria detectar.
 */
async function leerTarea(taskId: string): Promise<
  | {
      title: string;
      description: string | null;
      priority: string;
      due_date: string | null;
      position: number;
      column_id: string;
    }
  | undefined
> {
  const filas = await client.query<{
    title: string;
    description: string | null;
    priority: string;
    due_date: string | null;
    position: number;
    column_id: string;
  }>(
    `SELECT title, description, priority, due_date::text AS due_date, position, column_id::text AS column_id
       FROM task WHERE id = $1::uuid`,
    [taskId],
  );
  return filas.rows[0];
}

function cuerpoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: "Revisar HU-25", ...extra };
}

describe("POST /api/tasks", () => {
  it("201 sin position: la tarea queda al final de la columna y el orden es denso", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "ya-estaba",
      cantidad: 2,
    });
    const todo = porKey(tablero, "TODO");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_id: todo }),
      }),
    );

    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<Tarea>(respuesta);

    // Las claves exactas de la 6.3.1: un campo en camelCase o uno interno que se
    // cuele hacen fallar esto y no pasan callados.
    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_TAREA);
    expect(cuerpo.title).toBe("Revisar HU-25");
    expect(cuerpo.board_id).toBe(tablero.id);
    expect(cuerpo.column_id).toBe(todo);
    expect(cuerpo.position).toBe(2);

    // El estado real, por SQL.
    expect(await titulosPorPosicion(todo)).toEqual(["ya-estaba-0", "ya-estaba-1", "Revisar HU-25"]);
    await expectColumnaDensa(todo);
  });

  it("201 con position intermedia: las existentes se desplazan y el orden queda denso", async () => {
    // El caso que decide el paso. Se comprueba el ORDEN COMPLETO por SQL, no el
    // recuento: la densidad sola no distingue un indice de otro.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 3,
    });
    const todo = porKey(tablero, "TODO");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_id: todo, position: 1 }),
      }),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<Tarea>(respuesta)).position).toBe(1);

    expect(await titulosPorPosicion(todo)).toEqual(["t-0", "Revisar HU-25", "t-1", "t-2"]);
    await expectColumnaDensa(todo);
  });

  it("201 con position 0: entra primera y empuja a todas las demas", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });
    const todo = porKey(tablero, "TODO");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_id: todo, position: 0 }),
      }),
    );

    expect(respuesta.status).toBe(201);
    expect(await titulosPorPosicion(todo)).toEqual(["Revisar HU-25", "t-0", "t-1"]);
    await expectColumnaDensa(todo);
  });

  it("201 con una position mayor que la columna: se ajusta al final en vez de fallar", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });
    const todo = porKey(tablero, "TODO");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_id: todo, position: 99 }),
      }),
    );

    expect(respuesta.status).toBe(201);
    // Mismo criterio que `move` (5.2): quien calcula mal el indice obtiene un
    // resultado util, no un error.
    expect((await leerJson<Tarea>(respuesta)).position).toBe(2);
    expect(await titulosPorPosicion(todo)).toEqual(["t-0", "t-1", "Revisar HU-25"]);
  });

  it('201 con position null: la 6.3.1 lo documenta como "al final", no como 0', async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });
    const todo = porKey(tablero, "TODO");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_id: todo, position: null }),
      }),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<Tarea>(respuesta)).position).toBe(2);
    expect(await titulosPorPosicion(todo)).toEqual(["t-0", "t-1", "Revisar HU-25"]);
  });

  describe("referencia a la columna (6.3.1)", () => {
    it("201 con column_key en vez de column_id: crea en la columna correcta", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "IN_PROGRESS" }),
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.column_id).toBe(porKey(tablero, "IN_PROGRESS"));
      expect((await leerTarea(cuerpo.id))?.column_id).toBe(porKey(tablero, "IN_PROGRESS"));
    });

    it("201 con una column_key en otra capitalizacion y con blancos alrededor", async () => {
      // La key se normaliza con la misma funcion que al crear la columna.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "  in progress  " }),
        }),
      );

      expect(respuesta.status).toBe(201);
      expect((await leerJson<Tarea>(respuesta)).column_id).toBe(porKey(tablero, "IN_PROGRESS"));
    });

    it("con los DOS presentes y apuntando a columnas distintas, gana column_id", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const done = porKey(tablero, "DONE");

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_id: done, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<Tarea>(respuesta);

      // 6.3.1: "Si se envian ambos, column_id prevalece".
      expect(cuerpo.column_id).toBe(done);
      expect(await titulosPorPosicion(done)).toEqual(["Revisar HU-25"]);
      expect(await titulosPorPosicion(porKey(tablero, "TODO"))).toEqual([]);
    });

    it("409 COLUMN_NOT_IN_BOARD con un column_id de OTRO tablero", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const otro = await sembrarTablero(taskman, { name: "Otro" });
      const ajena = porKey(otro, "TODO");

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_id: ajena }),
        }),
      );

      expect(respuesta.status).toBe(409);

      const cuerpo = await leerError(respuesta);

      expect(cuerpo.error.code).toBe("COLUMN_NOT_IN_BOARD");
      expect(cuerpo.error.details).toMatchObject({
        boardId: tablero.id,
        columnId: ajena,
        columnBoardId: otro.id,
      });
      expect(await contarFilas(client, "task")).toBe(0);
    });

    it("404 COLUMN_NOT_FOUND con una column_key que el tablero no tiene", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "NO_EXISTE" }),
        }),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("COLUMN_NOT_FOUND");
    });

    it("404 BOARD_NOT_FOUND con un board_id que no existe", async () => {
      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: UUID_INEXISTENTE, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("BOARD_NOT_FOUND");
    });

    it("400 sin column_id ni column_key: es un cuerpo incompleto, no un 404", async () => {
      // Sin esta comprobacion del borde, el nucleo devuelve COLUMN_NOT_FOUND y el
      // cliente recibe un 404 por algo que nunca busco.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("due_date: fecha sin hora (6.1)", () => {
    it('"2026-09-11" queda como esa fecha exacta en la base y vuelve igual', async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({
            board_id: tablero.id,
            column_key: "TODO",
            due_date: "2026-09-11",
          }),
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.due_date).toBe("2026-09-11");
      // Lo que PostgreSQL tiene guardado, como texto: sin driver ni zona en el
      // medio. Si hubiera corrimiento de dia, acá se ve.
      expect((await leerTarea(cuerpo.id))?.due_date).toBe("2026-09-11");

      // Y tambien al leerla de vuelta por el otro endpoint.
      const leida = await obtener(
        peticion({ ruta: `/api/tasks/${cuerpo.id}`, clave: claveRead }),
        contextoDeRuta(cuerpo.id),
      );

      expect((await leerJson<Tarea>(leida)).due_date).toBe("2026-09-11");
    });

    it("ninguna fecha se corre de dia, ni en fin de mes ni en fin de ano", async () => {
      // Los dos bordes donde un corrimiento de zona se nota: el 1 y el 31. Con un
      // offset negativo, un dia 1 mal anclado retrocede al mes anterior.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const fechas = ["2026-01-01", "2026-12-31", "2026-06-30", "2024-02-29", "2026-03-01"];

      for (const fecha of fechas) {
        const respuesta = await crearTarea(
          peticion({
            metodo: "POST",
            ruta: "/api/tasks",
            clave: claveWrite,
            cuerpo: cuerpoValido({
              board_id: tablero.id,
              column_key: "TODO",
              title: `vence ${fecha}`,
              due_date: fecha,
            }),
          }),
        );

        expect(respuesta.status).toBe(201);

        const cuerpo = await leerJson<Tarea>(respuesta);

        expect(cuerpo.due_date).toBe(fecha);
        expect((await leerTarea(cuerpo.id))?.due_date).toBe(fecha);
      }
    });

    it("created_at y updated_at SI llevan hora y zona, a diferencia de due_date", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({
            board_id: tablero.id,
            column_key: "TODO",
            due_date: "2026-09-11",
          }),
        }),
      );

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.due_date).toBe("2026-09-11");
      expect(cuerpo.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(cuerpo.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("201 con due_date null: la tarea queda sin fecha", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", due_date: null }),
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.due_date).toBeNull();
      expect((await leerTarea(cuerpo.id))?.due_date).toBeNull();
    });

    it("201 sin due_date: tampoco queda fecha", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(201);
      expect((await leerJson<Tarea>(respuesta)).due_date).toBeNull();
    });

    it("400 con un due_date que lleva hora", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({
            board_id: tablero.id,
            column_key: "TODO",
            due_date: "2026-09-11T00:00:00.000Z",
          }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un dia que no existe en el calendario", async () => {
      // El caso que la expresion regular sola NO atrapa: `2026-02-30` tiene el
      // formato correcto, y `new Date` la corre sola al 2 de marzo en vez de
      // rechazarla. Sin el ida y vuelta del contrato, la tarea venceria tres dias
      // despues de lo que se pidio.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      for (const fecha of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-04-31"]) {
        const respuesta = await crearTarea(
          peticion({
            metodo: "POST",
            ruta: "/api/tasks",
            clave: claveWrite,
            cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", due_date: fecha }),
          }),
        );

        expect(respuesta.status, `due_date ${fecha} deberia ser 400`).toBe(400);
        expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      }

      expect(await contarFilas(client, "task")).toBe(0);
    });
  });

  describe("priority", () => {
    it("ausente queda en MEDIUM, que es el default del esquema", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<Tarea>(respuesta);

      expect(cuerpo.priority).toBe("MEDIUM");
      expect((await leerTarea(cuerpo.id))?.priority).toBe("MEDIUM");
    });

    it("las cuatro de la 6.3.1 se aceptan y se guardan", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      for (const priority of ["LOW", "MEDIUM", "HIGH", "URGENT"]) {
        const respuesta = await crearTarea(
          peticion({
            metodo: "POST",
            ruta: "/api/tasks",
            clave: claveWrite,
            cuerpo: cuerpoValido({
              board_id: tablero.id,
              column_key: "TODO",
              title: `prioridad ${priority}`,
              priority,
            }),
          }),
        );

        expect(respuesta.status, `priority ${priority}`).toBe(201);

        const cuerpo = await leerJson<Tarea>(respuesta);

        expect(cuerpo.priority).toBe(priority);
        expect((await leerTarea(cuerpo.id))?.priority).toBe(priority);
      }
    });

    it("400 con una priority que no esta en el enum", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", priority: "CRITICAL" }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await contarFilas(client, "task")).toBe(0);
    });

    it("400 con una priority en minuscula: el enum es en mayuscula", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", priority: "high" }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("cuerpo invalido", () => {
    it("400 sin title", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: { board_id: tablero.id, column_key: "TODO" },
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un title de solo espacios", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: { board_id: tablero.id, column_key: "TODO", title: "   " },
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un title de mas de 200 caracteres", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: { board_id: tablero.id, column_key: "TODO", title: "x".repeat(201) },
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await contarFilas(client, "task")).toBe(0);
    });

    it("400 sin board_id", async () => {
      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un board_id que no es UUID", async () => {
      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: "no-soy-un-uuid", column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con una position negativa", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", position: -1 }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un campo que el contrato no declara, en vez de ignorarlo", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          // `position` es lo editable; el orden real NO se setea a mano desde el
          // borde, y `created_at` tampoco se acepta del cliente.
          cuerpo: cuerpoValido({
            board_id: tablero.id,
            column_key: "TODO",
            created_at: "2020-01-01T00:00:00.000Z",
          }),
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await contarFilas(client, "task")).toBe(0);
    });

    it("400 con un cuerpo que no es JSON", async () => {
      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveWrite,
          cuerpoCrudo: "{ esto no cierra",
        }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("autorizacion", () => {
    it("401 sin la cabecera Authorization, y no crea nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
      expect(await contarFilas(client, "task")).toBe(0);
    });

    it("403 con una clave sin scope write, y no crea nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearTarea(
        peticion({
          metodo: "POST",
          ruta: "/api/tasks",
          clave: claveRead,
          cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO" }),
        }),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "write",
        granted_scopes: ["read"],
      });
      expect(await contarFilas(client, "task")).toBe(0);
    });
  });
});

describe("GET /api/tasks/{id}", () => {
  /** Crea una tarea por el borde y devuelve su id. */
  async function crearPorElBorde(extra: Record<string, unknown> = {}): Promise<{
    id: string;
    boardId: string;
  }> {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoValido({ board_id: tablero.id, column_key: "TODO", ...extra }),
      }),
    );

    expect(respuesta.status).toBe(201);
    return { id: (await leerJson<Tarea>(respuesta)).id, boardId: tablero.id };
  }

  it("200 con la tarea, en snake_case y con las claves de la 6.3.1", async () => {
    const { id, boardId } = await crearPorElBorde({
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      due_date: "2026-09-11",
    });

    const respuesta = await obtener(
      peticion({ ruta: `/api/tasks/${id}`, clave: claveRead }),
      contextoDeRuta(id),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<Tarea>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_TAREA);
    expect(cuerpo).toMatchObject({
      id,
      board_id: boardId,
      title: "Revisar HU-25",
      description: "Validar criterios de aceptacion",
      priority: "HIGH",
      due_date: "2026-09-11",
      position: 0,
    });
  });

  it("200 con una tarea sin descripcion ni fecha: los dos campos vienen en null", async () => {
    const { id } = await crearPorElBorde();

    const respuesta = await obtener(
      peticion({ ruta: `/api/tasks/${id}`, clave: claveRead }),
      contextoDeRuta(id),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<Tarea>(respuesta);

    // Null explicito y no la clave ausente: un cliente no tiene que distinguir
    // "no tiene fecha" de "el campo no vino".
    expect(cuerpo.description).toBeNull();
    expect(cuerpo.due_date).toBeNull();
  });

  it("404 TASK_NOT_FOUND con un id que no existe", async () => {
    const respuesta = await obtener(
      peticion({ ruta: `/api/tasks/${UUID_INEXISTENTE}`, clave: claveRead }),
      contextoDeRuta(UUID_INEXISTENTE),
    );

    expect(respuesta.status).toBe(404);
    expect((await leerError(respuesta)).error.code).toBe("TASK_NOT_FOUND");
  });

  it("400 con un id que no es UUID, sin llegar a consultar la base", async () => {
    const respuesta = await obtener(
      peticion({ ruta: "/api/tasks/no-soy-un-uuid", clave: claveRead }),
      contextoDeRuta("no-soy-un-uuid"),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization", async () => {
    const { id } = await crearPorElBorde();

    const respuesta = await obtener(
      peticion({ ruta: `/api/tasks/${id}` }),
      contextoDeRuta(id),
    );

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
  });

  it("403 con una clave sin scope read", async () => {
    const { id } = await crearPorElBorde();

    const respuesta = await obtener(
      peticion({ ruta: `/api/tasks/${id}`, clave: claveWrite }),
      contextoDeRuta(id),
    );

    expect(respuesta.status).toBe(403);
    expect((await leerError(respuesta)).error.details).toEqual({
      required_scope: "read",
      granted_scopes: ["write"],
    });
  });
});
