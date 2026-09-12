import type { ColumnaCreada } from "@taskman/contracts";
import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as crearColumna } from "../app/api/boards/[id]/columns/route.js";
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
} from "./helpers.js";

/**
 * Contrato REST de POST /api/boards/{id}/columns (6.2, RF-02).
 *
 * Mismo enfoque que el resto de la suite: el handler se importa y se invoca con
 * un `Request` armado a mano y con el contexto de ruta que le pasaria Next. Ver
 * el comentario de cabecera de `boards.test.ts` para el razonamiento completo,
 * incluido el de por que cada caso usa una clave con exactamente el scope que
 * necesita.
 *
 * El orden denso 0..n-1 se comprueba SIEMPRE por SQL y nunca por la respuesta:
 * lo que hay que verificar es el estado de la base tras reindexar, y leerlo del
 * cuerpo que acabamos de construir probaria que el adaptador se copia a si mismo.
 */

/** Las claves de `columna` (contracts): NO lleva task_count. */
const CLAVES_COLUMNA = [
  "board_id",
  "created_at",
  "id",
  "key",
  "name",
  "position",
  "updated_at",
];

/** Las cuatro por defecto de la 4.3, en orden. */
const POR_DEFECTO = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE"];

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

/** Las keys del tablero ordenadas por position, leidas de la base. */
async function keysPorPosicion(boardId: string): Promise<string[]> {
  const filas = await client.query<{ key: string }>(
    `SELECT key FROM board_column WHERE board_id = $1::uuid ORDER BY position`,
    [boardId],
  );
  return filas.rows.map((fila) => fila.key);
}

/**
 * El orden de columnas del tablero es exactamente 0..n-1, sin huecos ni
 * duplicados (ADR-004). Se lee de la base.
 */
async function expectTableroDenso(boardId: string): Promise<void> {
  const filas = await client.query<{ position: number }>(
    `SELECT position FROM board_column WHERE board_id = $1::uuid ORDER BY position`,
    [boardId],
  );
  const posiciones = filas.rows.map((fila) => fila.position);
  expect(posiciones).toEqual(posiciones.map((_, indice) => indice));
}

/** La key con la que quedo UNA columna, leida de la base por su id. */
async function keyEnLaBase(columnId: string): Promise<string | undefined> {
  const filas = await client.query<{ key: string }>(
    `SELECT key FROM board_column WHERE id = $1::uuid`,
    [columnId],
  );
  return filas.rows[0]?.key;
}

function cuerpoValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "En revision", key: "EN_REVISION", ...extra };
}

describe("POST /api/boards/{id}/columns", () => {
  it("201 sin position: la columna queda al final y el tablero sigue denso", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: cuerpoValido(),
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<ColumnaCreada>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(["column", "columns"]);
    expect(Object.keys(cuerpo.column).sort()).toEqual(CLAVES_COLUMNA);
    expect(cuerpo.column.key).toBe("EN_REVISION");
    expect(cuerpo.column.board_id).toBe(tablero.id);
    // Cuatro por defecto, asi que la quinta va en la position 4.
    expect(cuerpo.column.position).toBe(4);

    // El estado real, por SQL y no por la respuesta.
    expect(await keysPorPosicion(tablero.id)).toEqual([...POR_DEFECTO, "EN_REVISION"]);
    await expectTableroDenso(tablero.id);
  });

  it("201 con position intermedia: las existentes se desplazan y el orden sigue denso", async () => {
    // El caso que decide el paso. Insertar en el medio obliga a reescribir la
    // position de TODAS las siguientes, y el nucleo lo hace reescribiendo la
    // secuencia completa dentro de la transaccion que inserta.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: { name: "Bloqueado", key: "BLOCKED", position: 1 },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);

    const cuerpo = await leerJson<ColumnaCreada>(respuesta);

    expect(cuerpo.column.position).toBe(1);
    expect(await keysPorPosicion(tablero.id)).toEqual([
      "BACKLOG",
      "BLOCKED",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    await expectTableroDenso(tablero.id);

    // Y la respuesta trae el orden FINAL, no el previo: es la razon de devolver
    // `columns` ademas de `column`.
    expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "BLOCKED",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    expect(cuerpo.columns.map((columna) => columna.position)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(cuerpo.columns[0] ?? {}).sort()).toEqual(CLAVES_COLUMNA);
  });

  it("201 con position 0: entra primera y empuja a las cuatro por defecto", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: { name: "Entrada", key: "INBOX", position: 0 },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<ColumnaCreada>(respuesta)).column.position).toBe(0);
    expect(await keysPorPosicion(tablero.id)).toEqual(["INBOX", ...POR_DEFECTO]);
    await expectTableroDenso(tablero.id);
  });

  it("201 con una position mayor que el tablero: se ajusta al final en vez de fallar", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: cuerpoValido({ position: 99 }),
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);
    // Mismo criterio que `move` (5.2): el que calcula mal el indice obtiene un
    // resultado util, no un error.
    expect((await leerJson<ColumnaCreada>(respuesta)).column.position).toBe(4);
    expect(await keysPorPosicion(tablero.id)).toEqual([...POR_DEFECTO, "EN_REVISION"]);
    await expectTableroDenso(tablero.id);
  });

  it('201 con position "end" explicito, igual que omitirla', async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: cuerpoValido({ position: "end" }),
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<ColumnaCreada>(respuesta)).column.position).toBe(4);
    await expectTableroDenso(tablero.id);
  });

  it("no toca las tareas de las columnas que desplaza", async () => {
    // Reindexar columnas reescribe `board_column.position`, no `task.position`:
    // una tarea que estaba en TODO sigue en TODO aunque TODO cambie de lugar.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await sembrarTareas(taskman, {
      boardId: tablero.id,
      columnKey: "TODO",
      prefijo: "t",
      cantidad: 2,
    });

    const respuesta = await crearColumna(
      peticion({
        metodo: "POST",
        ruta: `/api/boards/${tablero.id}/columns`,
        clave: claveWrite,
        cuerpo: { name: "Bloqueado", key: "BLOCKED", position: 1 },
      }),
      contextoDeRuta(tablero.id),
    );

    expect(respuesta.status).toBe(201);
    expect(await contarFilas(client, "task")).toBe(2);

    const filas = await client.query<{ key: string; position: number }>(
      `SELECT c.key, t.position
         FROM task t JOIN board_column c ON c.id = t.column_id
        WHERE t.board_id = $1::uuid
        ORDER BY t.position`,
      [tablero.id],
    );

    expect(filas.rows).toEqual([
      { key: "TODO", position: 0 },
      { key: "TODO", position: 1 },
    ]);
  });

  describe("unicidad de la key", () => {
    it("409 DUPLICATE_KEY si la key ya existe en el tablero", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          // TODO es una de las cuatro por defecto de la 4.3.
          cuerpo: { name: "Por hacer otra vez", key: "TODO" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(409);

      const cuerpo = await leerError(respuesta);

      expect(cuerpo.error.code).toBe("DUPLICATE_KEY");
      expect(cuerpo.error.details).toMatchObject({ boardId: tablero.id, columnKey: "TODO" });
      // No se creo nada: siguen las cuatro por defecto.
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("409 tambien si la key colisiona DESPUES de normalizar", async () => {
      // " todo " normaliza a TODO, que ya existe. Si el borde no normalizara y
      // la base comparara el texto crudo, esto entraria como una segunda TODO.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "Otra", key: " todo " },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(409);
      expect((await leerError(respuesta)).error.code).toBe("DUPLICATE_KEY");
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("201 con la misma key en OTRO tablero: la unicidad es por tablero", async () => {
      const uno = await sembrarTablero(taskman, { name: "Uno" });
      const otro = await sembrarTablero(taskman, { name: "Otro" });

      const primera = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${uno.id}/columns`,
          clave: claveWrite,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta(uno.id),
      );

      expect(primera.status).toBe(201);

      const segunda = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${otro.id}/columns`,
          clave: claveWrite,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta(otro.id),
      );

      expect(segunda.status).toBe(201);

      const cuerpo = await leerJson<ColumnaCreada>(segunda);

      expect(cuerpo.column.board_id).toBe(otro.id);
      expect(await keysPorPosicion(uno.id)).toEqual([...POR_DEFECTO, "EN_REVISION"]);
      expect(await keysPorPosicion(otro.id)).toEqual([...POR_DEFECTO, "EN_REVISION"]);
    });
  });

  describe("normalizacion de la key (5.2)", () => {
    it('"en progreso" queda EN_PROGRESO: los blancos internos pasan a guion bajo', async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "En progreso largo", key: "en progreso largo" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<ColumnaCreada>(respuesta);

      expect(cuerpo.column.key).toBe("EN_PROGRESO_LARGO");
      // Y es lo que quedo en la base, no solo lo que dice la respuesta.
      expect(await keyEnLaBase(cuerpo.column.id)).toBe("EN_PROGRESO_LARGO");
    });

    it('" todo " queda TODO: solo se recorta, no aparece ningun guion bajo', async () => {
      // Sembrado SIN las cuatro por defecto: con ellas TODO ya existe y este
      // caso solo podria dar DUPLICATE_KEY, que es el test de mas arriba.
      const tablero = await sembrarTablero(taskman, {
        name: "Tablero",
        columns: [{ name: "Backlog", key: "BACKLOG" }],
      });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "Por hacer", key: " todo " },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<ColumnaCreada>(respuesta);

      expect(cuerpo.column.key).toBe("TODO");
      expect(await keyEnLaBase(cuerpo.column.id)).toBe("TODO");
      expect(await keysPorPosicion(tablero.id)).toEqual(["BACKLOG", "TODO"]);
    });

    it("el NAME solo se recorta: conserva sus espacios internos y su capitalizacion", async () => {
      // La normalizacion agresiva es de la key. El name es lo que ve una
      // persona, y convertirlo en EN_REVISION seria un bug de presentacion.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "  En revision  ", key: "EN_REVISION" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(201);
      expect((await leerJson<ColumnaCreada>(respuesta)).column.name).toBe("En revision");
    });
  });

  describe("tablero", () => {
    it("404 BOARD_NOT_FOUND con un id de tablero que no existe", async () => {
      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${UUID_INEXISTENTE}/columns`,
          clave: claveWrite,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta(UUID_INEXISTENTE),
      );

      expect(respuesta.status).toBe(404);
      expect((await leerError(respuesta)).error.code).toBe("BOARD_NOT_FOUND");
      expect(await contarFilas(client, "board_column")).toBe(0);
    });

    it("400 con un id de tablero que no es UUID, sin llegar a consultar la base", async () => {
      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: "/api/boards/no-soy-un-uuid/columns",
          clave: claveWrite,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta("no-soy-un-uuid"),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("cuerpo invalido", () => {
    it("400 sin name", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { key: "EN_REVISION" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("400 sin key: es obligatoria, no se deriva del name", async () => {
      // Derivarla del name seria adivinar el contrato con el que los agentes
      // referencian la columna, asi que se exige.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "En revision" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("400 con un name de solo espacios", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "   ", key: "EN_REVISION" },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con una key de solo espacios", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: { name: "En revision", key: "   " },
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un campo que el contrato no declara, en vez de ignorarlo", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          // El tablero va en la ruta: repetirlo en el cuerpo seria una segunda
          // fuente del mismo dato, libre de contradecir a la ruta.
          cuerpo: cuerpoValido({ board_id: tablero.id }),
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("400 con una position negativa", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: cuerpoValido({ position: -1 }),
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con una position decimal", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpo: cuerpoValido({ position: 1.5 }),
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un cuerpo que no es JSON", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveWrite,
          cuerpoCrudo: "{ esto no cierra",
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("autorizacion", () => {
    it("401 sin la cabecera Authorization, y no crea nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });

    it("403 con una clave sin scope write, y no crea nada", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await crearColumna(
        peticion({
          metodo: "POST",
          ruta: `/api/boards/${tablero.id}/columns`,
          clave: claveRead,
          cuerpo: cuerpoValido(),
        }),
        contextoDeRuta(tablero.id),
      );

      expect(respuesta.status).toBe(403);

      const cuerpo = await leerError(respuesta);

      expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
      expect(cuerpo.error.details).toEqual({
        required_scope: "write",
        granted_scopes: ["read"],
      });
      expect(await keysPorPosicion(tablero.id)).toEqual(POR_DEFECTO);
    });
  });
});
