import type { ListadoDeTareas } from "@taskman/contracts";
import type { BoardDetail, CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as consultarAuditoria } from "../app/api/audit/route";
import { GET as listarTableros } from "../app/api/boards/route";
import { DELETE as borrarColumna } from "../app/api/columns/[id]/route";
import { GET as listarTareas } from "../app/api/tasks/route";
import { GET as buscarTareas } from "../app/api/tasks/search/route";
import {
  connectDb,
  contextoDeRuta,
  ctx,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
  type CuerpoDeError,
} from "./helpers";

/**
 * Un parametro de consulta DESCONOCIDO es 400, en los cinco endpoints que leen
 * query string (6.4, VALIDATION_ERROR).
 *
 * Agrupado por MECANISMO y no por endpoint, como `cuerpo.test.ts` con el tope de
 * la 7.3, porque eso es lo que cambio: los cinco handlers armaban cada uno el
 * objeto a validar leyendo SOLO los parametros que conocen, asi que el
 * `strictObject` del contrato —que DECLARA que los desconocidos se rechazan—
 * nunca veia el de mas. Ahora los cinco leen por `leerConsulta`, que le entrega
 * al esquema todo lo que llego.
 *
 * LO QUE HAY QUE SOSTENER NO ES "devuelve 400": es que el parametro no quede
 * INERTE. El 200 no era el peligro; el peligro era creer que se acoto cuando no
 * se acoto, y por eso cada caso afirma tambien lo que el endpoint NO devolvio o
 * NO hizo. Un test que solo mirara el codigo pasaria igual si el handler
 * rechazara por cualquier otro motivo.
 */

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveDelete: string;

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
  claveDelete = await emitirClave(client, ["DELETE"]);
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

/**
 * El 400 completo: codigo, el parametro NOMBRADO en el mensaje y el mismo nombre
 * en `details`, que es donde lo busca un cliente que no quiera parsear la frase.
 *
 * Los dos sitios se comprueban juntos a proposito: el mensaje es para quien lee
 * la respuesta y `details.issues[].keys` para quien la programa, y que uno diga
 * `foo` mientras el otro dice otra cosa seria peor que no decirlo.
 */
async function esperarSobrante(respuesta: Response, sobrante: string): Promise<CuerpoDeError> {
  expect(respuesta.status).toBe(400);

  const cuerpo = await leerError(respuesta);

  expect(cuerpo.error.code).toBe("VALIDATION_ERROR");
  expect(cuerpo.error.message).toContain(`'${sobrante}'`);

  const issues = (cuerpo.error.details?.["issues"] ?? []) as ReadonlyArray<{
    code?: string;
    keys?: readonly string[];
  }>;
  const desconocidas = issues.filter((issue) => issue.code === "unrecognized_keys");

  expect(desconocidas.flatMap((issue) => issue.keys ?? [])).toContain(sobrante);

  return cuerpo;
}

describe("GET /api/boards", () => {
  it("400 con un parametro que el contrato no declara, y NO el listado entero", async () => {
    // `?name=` se escribe solo: quien busca un tablero por nombre supone que el
    // listado filtra. Ignorado, devolvia los tres y quien llamo leia el primero
    // como si fuera el que pidio.
    await sembrarTablero(taskman, { name: "Uno" });
    await sembrarTablero(taskman, { name: "Dos" });
    await sembrarTablero(taskman, { name: "Tres" });

    const respuesta = await listarTableros(
      peticion({ ruta: "/api/boards?name=Dos", clave: claveRead }),
    );

    const cuerpo = await esperarSobrante(respuesta, "name");

    expect(JSON.stringify(cuerpo)).not.toContain("Tres");
  });

  it("400 con el parametro de mas aunque los conocidos sean validos", async () => {
    const respuesta = await listarTableros(
      peticion({ ruta: "/api/boards?limit=2&offset=10", clave: claveRead }),
    );

    // `offset` es el que mas se prueba contra una API paginada por cursor.
    await esperarSobrante(respuesta, "offset");
  });
});

describe("GET /api/tasks", () => {
  it("400 con un parametro que el contrato no declara, y NO el tablero entero", async () => {
    // `?status=` es el nombre que tiene en casi cualquier otro gestor; aca la
    // columna se filtra con `column_key`. Ignorado, devolvia las dos tareas.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await taskman.createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "pendiente" },
      ctx(),
    );
    await taskman.createTask({ boardId: tablero.id, columnKey: "DONE", title: "hecha" }, ctx());

    const respuesta = await listarTareas(
      peticion({ ruta: `/api/tasks?board_id=${tablero.id}&status=DONE`, clave: claveRead }),
    );

    const cuerpo = await esperarSobrante(respuesta, "status");

    expect(JSON.stringify(cuerpo)).not.toContain("pendiente");
  });
});

describe("GET /api/tasks/search", () => {
  /**
   * EL CASO ANOTADO en la deuda —`?column_key=TODO`, que la busqueda no acepta y
   * devolvia el tablero entero— vive en `tasks-search.test.ts`, junto al resto
   * del contrato de este endpoint y a la explicacion de por que `column_key` no
   * esta en el. Aca van los dos casos que son del MECANISMO: el 400 generico y
   * que el hint propio del endpoint no tape al del parametro de mas.
   */
  it("el hint del endpoint NO tapa al del parametro de mas", async () => {
    // El hint propio de la busqueda manda a revisar `q`: contestarlo ante un
    // `?foo=1` mandaria a corregir el parametro equivocado.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await buscarTareas(
      peticion({
        ruta: `/api/tasks/search?board_id=${tablero.id}&q=algo&foo=1`,
        clave: claveRead,
      }),
    );

    const cuerpo = await esperarSobrante(respuesta, "foo");

    expect(cuerpo.error.hint).not.toContain("'q'");
  });

  it("sin el parametro de mas, el hint del endpoint sigue saliendo", async () => {
    /**
     * LA SONDA CAMBIO EN EL PASO 10b DE F4, y el caso no: este test necesita un
     * 400 del ESQUEMA —uno sin parametros desconocidos— para ver el hint propio
     * del endpoint. La sonda era `?q=algo` sin ambito, que entonces fallaba por
     * el `.refine` de `consultaDeBusqueda`; ahora esa peticion es una busqueda
     * global valida y devuelve 200. La sonda pasa a ser la falta de `q`, que es
     * la unica regla propia que le queda al esquema de la busqueda.
     */
    const respuesta = await buscarTareas(
      peticion({ ruta: "/api/tasks/search", clave: claveRead }),
    );

    expect(respuesta.status).toBe(400);
    expect((await leerError(respuesta)).error.hint).toContain("'q'");
  });
});

describe("GET /api/audit", () => {
  it("400 con un filtro que el log no ofrece, y NO el log entero", async () => {
    /**
     * `?action=` y `?request_id=` son los dos filtros que el log NO tiene —no
     * hay indice por esas columnas, y queda anotado como deuda— asi que son
     * exactamente los que alguien escribe esperando que funcionen. Ignorados,
     * la respuesta era el log completo con forma de log filtrado.
     */
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await taskman.createTask({ boardId: tablero.id, columnKey: "TODO", title: "t" }, ctx());

    const respuesta = await consultarAuditoria(
      peticion({ ruta: "/api/audit?action=task.created", clave: claveRead }),
    );

    const cuerpo = await esperarSobrante(respuesta, "action");

    expect(JSON.stringify(cuerpo)).not.toContain("board.created");
  });
});

describe("DELETE /api/columns/{id}", () => {
  it("400 con reassign_to mal tipeado, y la columna NO se borra", async () => {
    /**
     * El unico de los cinco que ESCRIBE, y por eso el que mas costaba: ignorado,
     * `?reasign_to=` (una s) borraba con el comportamiento de "no reasignar".
     * Sobre una columna vacia eso es un 204 y una columna menos, sin que nadie
     * se entere de que la reasignacion que se pidio no ocurrio.
     */
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const vacia = porKey(tablero, "BACKLOG");
    const destino = porKey(tablero, "TODO");

    const respuesta = await borrarColumna(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${vacia}?reasign_to=${destino}`,
        clave: claveDelete,
      }),
      contextoDeRuta(vacia),
    );

    await esperarSobrante(respuesta, "reasign_to");

    const despues = await taskman.getBoard(tablero.id);

    expect(despues.columns.map((columna) => columna.id)).toContain(vacia);
  });

  it("reassign_to bien escrito sigue borrando y reasignando", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const origen = porKey(tablero, "BACKLOG");
    const destino = porKey(tablero, "TODO");
    await taskman.createTask({ boardId: tablero.id, columnKey: "BACKLOG", title: "t" }, ctx());

    const respuesta = await borrarColumna(
      peticion({
        metodo: "DELETE",
        ruta: `/api/columns/${origen}?reassign_to=${destino}`,
        clave: claveDelete,
      }),
      contextoDeRuta(origen),
    );

    expect(respuesta.status).toBe(204);

    const despues = await taskman.getBoard(tablero.id);

    expect(despues.columns.map((columna) => columna.id)).not.toContain(origen);
    expect((await taskman.listTasks({ limit: 10, columnId: destino })).items).toHaveLength(1);
  });
});

describe("lo que este cambio no puede romper", () => {
  /**
   * LOS REPETIBLES son lo que mas facil se rompe al pasar de leer parametro por
   * parametro a leerlos todos: un `Object.fromEntries` ingenuo se queda con el
   * ULTIMO valor y `?priority=HIGH&priority=URGENT` dejaria de ser un OR sin dar
   * ningun error.
   *
   * `tasks-list.test.ts` ya afirma el OR por el lado del filtro. Aca se repite
   * por el lado del mecanismo, que es el que cambio: si algun dia el listado
   * dejara de declarar `priority` como repetible, este es el archivo donde mirar.
   */
  it("priority repetido sigue siendo un OR y no el ultimo valor", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    for (const priority of ["LOW", "HIGH", "URGENT"] as const) {
      await taskman.createTask(
        { boardId: tablero.id, columnKey: "TODO", title: `es ${priority}`, priority },
        ctx(),
      );
    }

    const respuesta = await listarTareas(
      peticion({
        ruta: `/api/tasks?board_id=${tablero.id}&priority=HIGH&priority=URGENT`,
        clave: claveRead,
      }),
    );

    expect(respuesta.status).toBe(200);

    const cuerpo = await leerJson<ListadoDeTareas>(respuesta);

    expect(cuerpo.items.map((tarea) => tarea.priority).sort()).toEqual(["HIGH", "URGENT"]);
  });

  it("priority con UN solo valor sigue llegando como lista", async () => {
    // El repetible va al esquema como array aunque llegue uno solo: colapsarlo a
    // texto porque vino una vez lo haria fallar contra el `z.array(...)`.
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await taskman.createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "es LOW", priority: "LOW" },
      ctx(),
    );
    await taskman.createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "es HIGH", priority: "HIGH" },
      ctx(),
    );

    const respuesta = await listarTareas(
      peticion({ ruta: `/api/tasks?board_id=${tablero.id}&priority=LOW`, clave: claveRead }),
    );

    expect(respuesta.status).toBe(200);
    expect((await leerJson<ListadoDeTareas>(respuesta)).items.map((t) => t.title)).toEqual([
      "es LOW",
    ]);
  });

  it("un parametro ESCALAR repetido es 400 y no su primer valor", async () => {
    /**
     * No es el caso que esta entrada venia a cerrar, pero es el mismo silencio y
     * cae del mismo lado: `get()` se quedaba con el primero y descartaba el
     * resto sin decirlo. Ahora el escalar repetido llega como array, no pasa el
     * esquema y sale con el 400 que lo nombra.
     *
     * Es un CAMBIO DE COMPORTAMIENTO deliberado: antes `?limit=1&limit=200`
     * devolvia una tarea.
     */
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await listarTareas(
      peticion({
        ruta: `/api/tasks?board_id=${tablero.id}&limit=1&limit=200`,
        clave: claveRead,
      }),
    );

    expect(respuesta.status).toBe(400);

    const cuerpo = await leerError(respuesta);

    expect(cuerpo.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(cuerpo.error.details)).toContain("limit");
  });

  it("una consulta sin ningun parametro sigue valiendo", async () => {
    // El objeto que se le pasa al esquema queda VACIO, no con las claves
    // conocidas en undefined: los `default` y los `optional` tienen que seguir
    // aplicando igual.
    await sembrarTablero(taskman, { name: "Uno" });

    const respuesta = await listarTableros(peticion({ ruta: "/api/boards", clave: claveRead }));

    expect(respuesta.status).toBe(200);
  });

  it("__proto__ tampoco se cuela: es 400 como cualquier otro desconocido", async () => {
    /**
     * El unico nombre que sobrevivia al arreglo si el objeto a validar fuera un
     * literal: la asignacion entra por el setter de `__proto__` y no crea
     * ninguna propiedad propia, asi que el parametro desaparece antes del
     * esquema. `leerConsulta` arma el objeto con prototipo nulo por esto.
     */
    const respuesta = await listarTableros(
      peticion({ ruta: "/api/boards?__proto__=x", clave: claveRead }),
    );

    await esperarSobrante(respuesta, "__proto__");
  });
});
