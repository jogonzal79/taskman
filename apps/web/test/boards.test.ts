import type { ListadoDeTableros, TableroDetallado } from "@taskman/contracts";
import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listar, POST as crear } from "../app/api/boards/route";
import {
  connectDb,
  contarFilas,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de /api/boards (6.2), nivel "Contrato REST" de la 10.
 *
 * Los Route Handlers se IMPORTAN y se invocan con un `Request` armado a mano: no
 * hay servidor ni puerto. Lo que se ejercita es la cadena completa del
 * adaptador —`conAuth`, la validacion de entrada, el servicio, la validacion de
 * salida y el mapeo de errores de la 6.4— contra PostgreSQL real. Lo que NO se
 * ejercita es el ruteo de Next ni el bundler, y es deliberado: esa capa la cubre
 * `next build`, que ya corre dentro de `verify`.
 *
 * Las CLAVES de cada caso tienen exactamente el scope que hace falta y ninguno
 * mas, y hay un caso espejo con una clave que NO lo tiene. Los dos hacen falta:
 * el primero falla si alguien vuelve el endpoint mas restrictivo, el segundo si
 * alguien lo vuelve mas permisivo. Una clave con los tres scopes no detectaria
 * ni uno de los dos cambios.
 */

/** Las claves de `tablero` (contracts), escritas a mano a proposito. */
const CLAVES_TABLERO = ["created_at", "description", "id", "name", "updated_at"];

/** Las claves de `columnaDetallada`. */
const CLAVES_COLUMNA = [
  "board_id",
  "created_at",
  "id",
  "key",
  "name",
  "position",
  "task_count",
  "updated_at",
];

/** Las de `tableroDetallado`: un tablero mas columnas y recuento. */
const CLAVES_DETALLE = [...CLAVES_TABLERO, "columns", "task_count"].sort();

/**
 * Las columnas del tablero LEIDAS DE LA BASE, en su orden.
 *
 * Por SQL y no por la respuesta del endpoint: lo que hay que probar es que se
 * creo lo que se pidio, y preguntarselo al mismo endpoint que lo creo es
 * preguntarle al acusado. El `ORDER BY position` ademas comprueba que las
 * posiciones son las que ordenan, no el orden de insercion.
 */
async function columnasEnLaBase(
  client: Client,
  boardId: string,
): Promise<Array<{ key: string; name: string; position: number }>> {
  const filas = await client.query<{ key: string; name: string; position: number }>(
    `SELECT key, name, position FROM board_column WHERE board_id = $1::uuid ORDER BY position`,
    [boardId],
  );
  return filas.rows;
}

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
  // Las claves se emiten despues del TRUNCATE que las borra, en cada test: la
  // suite no depende de ninguna clave preexistente y se puede correr dos veces
  // seguidas sin tocar nada a mano.
  claveRead = await emitirClave(client, ["READ"]);
  claveWrite = await emitirClave(client, ["WRITE"]);
});

describe("GET /api/boards", () => {
  it("200 con los tableros, en snake_case y ordenados por nombre", async () => {
    await sembrarTablero(taskman, { name: "Beta" });
    await sembrarTablero(taskman, { name: "Alfa", description: "la primera" });

    const respuesta = await listar(peticion({ clave: claveRead }));

    expect(respuesta.status).toBe(200);
    // 6.1: toda respuesta lleva X-Request-Id, y un listado no se cachea.
    expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");

    const cuerpo = await leerJson<ListadoDeTableros>(respuesta);

    expect(cuerpo.items.map((item) => item.name)).toEqual(["Alfa", "Beta"]);
    expect(cuerpo.next_cursor).toBeNull();
    // Las claves exactas, no un subconjunto: asi un campo en camelCase o uno
    // interno que se cuele hacen fallar esto y no pasan callados.
    expect(Object.keys(cuerpo).sort()).toEqual(["items", "next_cursor"]);
    expect(Object.keys(cuerpo.items[0] ?? {}).sort()).toEqual(CLAVES_TABLERO);
    expect(cuerpo.items[0]?.description).toBe("la primera");
    expect(cuerpo.items[1]?.description).toBeNull();
  });

  it("200 con lista vacia cuando no hay ningun tablero", async () => {
    const respuesta = await listar(peticion({ clave: claveRead }));

    expect(respuesta.status).toBe(200);
    expect(await leerJson<ListadoDeTableros>(respuesta)).toEqual({
      items: [],
      next_cursor: null,
    });
  });

  it("401 sin la cabecera Authorization, con el request_id del cuerpo igual al de la cabecera", async () => {
    const respuesta = await listar(peticion({}));

    expect(respuesta.status).toBe(401);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("UNAUTHENTICATED");
    // 6.1: el request_id del cuerpo es el que correlaciona con la cabecera.
    expect(cuerpo.error.request_id).toBe(respuesta.headers.get("X-Request-Id"));
    // RFC 7235: todo 401 lleva el desafio, con el esquema de la 7.1.
    expect(respuesta.headers.get("WWW-Authenticate")).toBe('Bearer realm="taskman"');
  });

  it("401 con una clave que no existe", async () => {
    const respuesta = await listar(peticion({ clave: "tmk_live_noexisteestaclaveenlabase" }));

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
  });

  it("403 con una clave sin scope read", async () => {
    const respuesta = await listar(peticion({ clave: claveWrite }));

    expect(respuesta.status).toBe(403);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "read",
      granted_scopes: ["write"],
    });
  });

  it("400 con un limit que no es un numero, en vez de caer en el valor por defecto", async () => {
    const respuesta = await listar(peticion({ ruta: "/api/boards?limit=abc", clave: claveRead }));

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("400 con un limit por encima del maximo de la 6.1", async () => {
    const respuesta = await listar(peticion({ ruta: "/api/boards?limit=201", clave: claveRead }));

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/boards", () => {
  it("201 con las cuatro columnas por defecto de la 4.3, con sus keys y posiciones", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpo: { name: "Nuevo" } }),
    );

    expect(respuesta.status).toBe(201);

    const cuerpo = await leerJson<TableroDetallado>(respuesta);

    expect(Object.keys(cuerpo).sort()).toEqual(CLAVES_DETALLE);
    expect(cuerpo.name).toBe("Nuevo");
    expect(cuerpo.description).toBeNull();

    // La 4.3 fija el orden Y las keys: son el contrato con el que los agentes
    // resuelven referencias por nombre, asi que se comprueban las dos cosas.
    expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    expect(cuerpo.columns.map((columna) => columna.name)).toEqual([
      "Backlog",
      "Por hacer",
      "En progreso",
      "Completado",
    ]);
    expect(cuerpo.columns.map((columna) => columna.position)).toEqual([0, 1, 2, 3]);
    expect(cuerpo.columns.map((columna) => columna.task_count)).toEqual([0, 0, 0, 0]);
    expect(cuerpo.task_count).toBe(0);
    expect(Object.keys(cuerpo.columns[0] ?? {}).sort()).toEqual(CLAVES_COLUMNA);
    expect(cuerpo.columns.every((columna) => columna.board_id === cuerpo.id)).toBe(true);

    // Y quedaron en la base, no solo en la respuesta.
    expect(await contarFilas(client, "board")).toBe(1);
    expect(await contarFilas(client, "board_column")).toBe(4);
  });

  describe("columns propias (4.3)", () => {
    /**
     * La 4.3 escribe la regla entera: "Al crear un tablero SIN ESPECIFICAR
     * COLUMNAS, el sistema DEBE crear las cuatro columnas por defecto". Esa
     * frase presupone que especificarlas es posible, y `BoardService.create` lo
     * hace desde F1; lo que faltaba era que el contrato REST lo dejara pasar.
     *
     * El caso de MAS ARRIBA —"201 con las cuatro columnas por defecto"— es la
     * otra mitad, y la que mas facil se rompe con este cambio: si `columns`
     * ausente dejara de caer en las cuatro, ese es el que se pone rojo.
     */
    it("201 con columns crea ESAS columnas y no las cuatro de la 4.3", async () => {
      const respuesta = await crear(
        peticion({
          metodo: "POST",
          clave: claveWrite,
          cuerpo: {
            name: "Flujo propio",
            columns: [
              { key: "IDEAS", name: "Ideas" },
              { key: "HACIENDO", name: "Haciendo" },
              { key: "LISTO", name: "Listo" },
            ],
          },
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<TableroDetallado>(respuesta);

      expect(cuerpo.columns.map((columna) => columna.key)).toEqual([
        "IDEAS",
        "HACIENDO",
        "LISTO",
      ]);

      // Y ninguna de las cuatro por defecto se sumo al lado.
      expect(cuerpo.columns).toHaveLength(3);
      expect(cuerpo.columns.map((columna) => columna.key)).not.toContain("BACKLOG");

      // La base, que es la que manda.
      expect(await columnasEnLaBase(client, cuerpo.id)).toEqual([
        { key: "IDEAS", name: "Ideas", position: 0 },
        { key: "HACIENDO", name: "Haciendo", position: 1 },
        { key: "LISTO", name: "Listo", position: 2 },
      ]);
      expect(await contarFilas(client, "board_column")).toBe(3);
    });

    it("la posicion es el ORDEN DEL ARRAY y las keys se normalizan en el nucleo", async () => {
      /**
       * El borde NO normaliza la key a proposito (ver `keyDeColumna` en
       * contracts): normalizar es de la 5.2 y `normalizarColumnKey` es su unica
       * definicion. Este caso lo comprueba de punta a punta: entra " ideas " y
       * "en revision", y sale IDEAS y EN_REVISION, con el blanco interno
       * colapsado en guion bajo.
       */
      const respuesta = await crear(
        peticion({
          metodo: "POST",
          clave: claveWrite,
          cuerpo: {
            name: "Normalizado",
            columns: [
              { key: " ideas ", name: "  Ideas  " },
              { key: "en revision", name: "En revision" },
            ],
          },
        }),
      );

      expect(respuesta.status).toBe(201);

      const cuerpo = await leerJson<TableroDetallado>(respuesta);

      expect(await columnasEnLaBase(client, cuerpo.id)).toEqual([
        { key: "IDEAS", name: "Ideas", position: 0 },
        { key: "EN_REVISION", name: "En revision", position: 1 },
      ]);
    });

    it("409 DUPLICATE_KEY con dos keys que normalizan igual, y NO queda tablero huerfano", async () => {
      /**
       * "todo" y " TODO " son la MISMA key tras normalizar, y el borde no puede
       * verlo: no normaliza. O sea que este cuerpo pasa el esquema entero y lo
       * rechaza `BoardService.create`, que es el unico que ve las keys ya
       * normalizadas. Es el mismo DUPLICATE_KEY 409 con el que POST
       * /api/boards/{id}/columns rechaza una key que ya existe en el tablero.
       *
       * LO QUE ESTE CASO PRUEBA es que no queda un tablero a medio construir. Lo
       * que NO prueba es el rollback: el servicio compara las keys ANTES de
       * abrir la transaccion, asi que aca no se escribio nada que revertir. El
       * rollback de verdad —tablero y columnas insertados y deshechos por un
       * fallo posterior— lo cubre `packages/core/test/audit.test.ts` en "cuando
       * falla el propio AuditService", donde el fallo ocurre DENTRO de la
       * transaccion y las filas desaparecen.
       */
      const respuesta = await crear(
        peticion({
          metodo: "POST",
          clave: claveWrite,
          cuerpo: {
            name: "Repetida",
            columns: [
              { key: "todo", name: "Uno" },
              { key: "OTRA", name: "Dos" },
              { key: " TODO ", name: "Tres" },
            ],
          },
        }),
      );

      expect(respuesta.status).toBe(409);

      const cuerpo = await leerError(respuesta);

      expect(cuerpo.error.code).toBe("DUPLICATE_KEY");
      expect(cuerpo.error.details).toMatchObject({ columnKey: "TODO" });

      // Ni el tablero, ni la columna que si era valida.
      expect(await contarFilas(client, "board")).toBe(0);
      expect(await contarFilas(client, "board_column")).toBe(0);
    });

    it("400 con columns vacio: omitirlo pide las cuatro, vaciarlo es un error", async () => {
      /**
       * `[]` NO cae en el `input.columns ?? COLUMNAS_POR_DEFECTO` del nucleo
       * —solo cae `undefined`— asi que sin el `.min(1)` del esquema esto crearia
       * un tablero SIN NINGUNA COLUMNA, donde no entra ninguna tarea. Son dos
       * intenciones distintas y el contrato las distingue.
       */
      const respuesta = await crear(
        peticion({ metodo: "POST", clave: claveWrite, cuerpo: { name: "Vacio", columns: [] } }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      expect(await contarFilas(client, "board")).toBe(0);
      expect(await contarFilas(client, "board_column")).toBe(0);
    });

    it("400 con una columna mal formada, y details dice cual y por que", async () => {
      // Los cinco los atrapa el ESQUEMA, que es donde el error puede nombrar el
      // indice del array y el campo. Ninguno llega al nucleo.
      const casos: Array<{ nombre: string; columns: unknown; enDetalle: string }> = [
        { nombre: "sin name", columns: [{ key: "IDEAS" }], enDetalle: "name" },
        {
          nombre: "campo de mas",
          columns: [{ key: "IDEAS", name: "Ideas", position: 0 }],
          enDetalle: "position",
        },
        { nombre: "name en blanco", columns: [{ key: "IDEAS", name: "   " }], enDetalle: "name" },
        { nombre: "key en blanco", columns: [{ key: " ", name: "Ideas" }], enDetalle: "key" },
        { nombre: "no es un objeto", columns: ["IDEAS"], enDetalle: "columns" },
      ];

      for (const caso of casos) {
        await truncateAll(client);
        const clave = await emitirClave(client, ["WRITE"]);

        const respuesta = await crear(
          peticion({ metodo: "POST", clave, cuerpo: { name: "Mal formada", columns: caso.columns } }),
        );

        expect(respuesta.status, caso.nombre).toBe(400);

        const cuerpo = await leerError(respuesta);

        expect(cuerpo.error.code, caso.nombre).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(cuerpo.error.details), caso.nombre).toContain(caso.enDetalle);
        expect(await contarFilas(client, "board"), caso.nombre).toBe(0);
      }
    });

    it("400 COLUMN_KEY_TOO_LONG con una key larga, con la POSICION en details", async () => {
      /**
       * El borde NO le pone tope de largo a la key, y no por olvido: el nucleo
       * mide los 40 caracteres DESPUES de normalizar, y normalizar cambia el
       * largo en los dos sentidos. Asi que este cuerpo pasa el esquema y lo
       * rechaza el nucleo; lo interesante es lo que devuelve, porque
       * `details.position` dice CUAL de las columnas del array fallo, que es lo
       * unico accionable cuando vienen varias.
       */
      const respuesta = await crear(
        peticion({
          metodo: "POST",
          clave: claveWrite,
          cuerpo: {
            name: "Key larga",
            columns: [
              { key: "IDEAS", name: "Ideas" },
              { key: "k".repeat(41), name: "Larga" },
            ],
          },
        }),
      );

      expect(respuesta.status).toBe(400);

      const cuerpo = await leerError(respuesta);

      expect(cuerpo.error.code).toBe("COLUMN_KEY_TOO_LONG");
      expect(cuerpo.error.details).toMatchObject({ position: 1, field: "key", maxLength: 40 });
      expect(await contarFilas(client, "board")).toBe(0);
    });

    it("403 con una clave sin scope write, tambien con columns", async () => {
      const respuesta = await crear(
        peticion({
          metodo: "POST",
          clave: claveRead,
          cuerpo: { name: "Flujo propio", columns: [{ key: "IDEAS", name: "Ideas" }] },
        }),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.code).toBe("FORBIDDEN_SCOPE");
      expect(await contarFilas(client, "board")).toBe(0);
    });
  });

  it("201 conserva la descripcion enviada", async () => {
    const respuesta = await crear(
      peticion({
        metodo: "POST",
        clave: claveWrite,
        cuerpo: { name: "Con descripcion", description: "algo" },
      }),
    );

    expect(respuesta.status).toBe(201);
    expect((await leerJson<TableroDetallado>(respuesta)).description).toBe("algo");
  });

  it("400 con un nombre vacio tras recortar los espacios", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpo: { name: "   " } }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("400 con un campo que el contrato no declara, en vez de ignorarlo", async () => {
    /**
     * `crearTablero` es strictObject: un campo de mas no queda ignorado en
     * silencio, es un 400 que dice cual sobra.
     *
     * El campo de este caso era `columns` hasta el paso 10a de F4, que lo
     * incorporo al contrato. Se cambio por `owner`, que el contrato no declara
     * ni va a declarar —no hay usuarios en el sistema— y no se borro el caso: lo
     * que afirma sigue siendo cierto y sigue haciendo falta. Que el campo que
     * elegimos como ejemplo haya dejado de ser desconocido no dice nada del
     * mecanismo.
     */
    const respuesta = await crear(
      peticion({
        metodo: "POST",
        clave: claveWrite,
        cuerpo: { name: "Con dueno", owner: "jonathan" },
      }),
    );

    expect(respuesta.status).toBe(400);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(cuerpo.error.details)).toContain("owner");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("400 con un cuerpo que no es JSON", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveWrite, cuerpoCrudo: "esto no es json" }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
  });

  it("401 sin la cabecera Authorization, y no crea nada", async () => {
    const respuesta = await crear(peticion({ metodo: "POST", cuerpo: { name: "Anonimo" } }));

    expect(respuesta.status).toBe(401);
    expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    expect(await contarFilas(client, "board")).toBe(0);
  });

  it("403 con una clave sin scope write, y no crea nada", async () => {
    const respuesta = await crear(
      peticion({ metodo: "POST", clave: claveRead, cuerpo: { name: "Solo lectura" } }),
    );

    expect(respuesta.status).toBe(403);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("FORBIDDEN_SCOPE");
    expect(cuerpo.error.details).toEqual({
      required_scope: "write",
      granted_scopes: ["read"],
    });
    expect(await contarFilas(client, "board")).toBe(0);
  });
});
