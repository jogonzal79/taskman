import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  crearHerramientas,
  IDENTIDAD_SERVIDOR_MCP,
  INSTRUCCIONES_MCP,
  isDomainError,
  montarHerramientas,
  SCOPES,
  type BoardDetail,
  type CamposDeLog,
  type CorePort,
  type DomainError,
  type Logger,
  type Scope,
  type TaskManagerPort,
} from "@taskman/core";
import { HttpPort } from "@taskman/mcp-stdio/http-port";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reiniciarLimiteDePeticiones, LIMITE_POR_CUBO } from "../lib/rate-limit";
import {
  connectDb,
  contarFilas,
  ctx,
  emitirClave,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";
import { levantarServidorRest, type ServidorRest } from "./servidor-rest";

/**
 * `HttpPort` (ADR-003, 8.1): la segunda implementacion de `TaskManagerPort`, la
 * que habla con la API REST con una API key en vez de con los servicios en
 * proceso.
 *
 * SE PRUEBA CONTRA UN SERVIDOR HTTP DE VERDAD (`servidor-rest.ts`): los Route
 * Handlers de /api detras de un `node:http` en un puerto efimero, con `fetch`
 * real, cabeceras reales y la base real. Un cliente HTTP probado contra un doble
 * de `fetch` prueba el doble.
 *
 * LO QUE ESTA SUITE AFIRMA, y es lo que decide si el paso sirve: que un agente NO
 * PUEDE NOTAR por que puerta entro. Por eso casi todo se mide comparando las DOS
 * implementaciones —el mismo catalogo de herramientas montado dos veces, una
 * sobre `CorePort` y otra sobre `HttpPort`— en vez de contra valores escritos a
 * mano. Un valor escrito a mano solo dice que HttpPort hace algo; la comparacion
 * dice que hace LO MISMO.
 *
 * DONDE VIVE Y POR QUE. `HttpPort` esta en `apps/mcp-stdio` (ver la cabecera de
 * `http-port.ts` para el razonamiento completo contra la 3.2 y la 3.3) y su
 * servidor esta aca, y ninguna de las dos apps puede importar a la otra en
 * tiempo de ejecucion. La prueba tiene que ver las dos puntas del cable, asi que
 * vive del lado del servidor y alcanza el cliente por una devDependency. Es una
 * dependencia de PRUEBA: el grafo de la 3.3 no cambia.
 */

interface LineaCapturada {
  readonly campos: CamposDeLog;
  readonly mensaje: string;
}

let db: Client;
let servidor: ServidorRest;
let taskman: CorePort;

/** Clave con los tres scopes de la 7.2: la que usa casi toda la suite. */
let claveCompleta: string;
/** Solo lectura, para el caso de scope insuficiente. */
let claveLectura: string;

let lineas: LineaCapturada[];
let httpPort: HttpPort;

/** El cliente MCP sobre `HttpPort` y el mismo catalogo sobre `CorePort`. */
let porHttp: McpClient;
let porCore: McpClient;

function loggerCapturador(): Logger {
  const anotar = (campos: CamposDeLog, mensaje: string): void => {
    lineas.push({ campos, mensaje });
  };
  return { debug: anotar, info: anotar, warn: anotar, error: anotar };
}

/**
 * El MISMO registro de herramientas de la 8.1 montado sobre el puerto que se le
 * pase. Es el `crearServidorMcp` de `apps/mcp-stdio` sin lo unico propio del
 * transporte stdio (de donde sale el nombre del cliente), que aca no se mide.
 *
 * LOS TRES SCOPES POR DEFECTO, tambien cuando la clave es de solo lectura:
 * montando las once contra una clave que no alcanza se mide que ve el agente
 * cuando el servidor le dice que no, que es lo que afirma el bloque de codigos
 * del borde. El CATALOGO recortado por los scopes de la clave —lo que la 8.1
 * pide y lo que `apps/mcp-stdio` hace en modo http— se mide en su propio bloque,
 * pasandolos explicitos.
 */
async function conectar(
  puerto: TaskManagerPort,
  scopes: readonly Scope[] = SCOPES,
): Promise<McpClient> {
  const server = new McpServer(IDENTIDAD_SERVIDOR_MCP, { instructions: INSTRUCCIONES_MCP });
  montarHerramientas(server, crearHerramientas(puerto, { scopes }));

  const [delCliente, delServidor] = InMemoryTransport.createLinkedPair();
  const cliente = new McpClient({ name: "prueba-http-port", version: "0.0.0" });
  await Promise.all([server.connect(delServidor), cliente.connect(delCliente)]);

  return cliente;
}

beforeAll(async () => {
  db = await connectDb();
  taskman = port();
  servidor = await levantarServidorRest();
});

afterAll(async () => {
  await porHttp?.close();
  await porCore?.close();
  await servidor.cerrar();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
  reiniciarLimiteDePeticiones();

  // La etiqueta NO dice "agente" desde el paso 12: la palabra pasó a nombrar el
  // rotulo de `api_key.actor_type`, y esta clave no lo tiene —audita API, como
  // cualquier cliente REST—. Llamarla "del agente" haria leer AGENT donde dice
  // API justo en las pruebas que separan las dos cosas.
  claveCompleta = await emitirClave(db, ["READ", "WRITE", "DELETE"], { label: "clave de HttpPort" });
  claveLectura = await emitirClave(db, ["READ"], { label: "clave de solo lectura" });

  lineas = [];
  httpPort = new HttpPort({
    baseUrl: servidor.url,
    apiKey: claveCompleta,
    logger: loggerCapturador(),
  });

  await porHttp?.close();
  await porCore?.close();
  porHttp = await conectar(httpPort);
  porCore = await conectar(taskman);
});

// --- Utilidades del borde MCP ------------------------------------------------

interface Resultado {
  texto: string;
  json: Record<string, unknown>;
  isError: boolean;
}

/** El bloque JSON de la 8.5 va al final del texto, entre vallas ```json. */
function extraerJson(texto: string): Record<string, unknown> {
  const inicio = texto.indexOf("```json\n");
  const fin = texto.lastIndexOf("\n```");
  if (inicio === -1 || fin <= inicio) {
    throw new Error(`La respuesta no trae bloque JSON:\n${texto}`);
  }
  return JSON.parse(texto.slice(inicio + "```json\n".length, fin)) as Record<string, unknown>;
}

async function llamarCon(
  cliente: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Resultado> {
  const salida = await cliente.callTool({ name, arguments: args });
  const bloques = salida.content as Array<{ type: string; text?: string }>;

  expect(bloques).toHaveLength(1);
  const texto = bloques[0]?.text ?? "";

  return { texto, json: extraerJson(texto), isError: salida.isError === true };
}

/** Por HttpPort, que es el camino que esta suite ejercita. */
async function llamar(name: string, args: Record<string, unknown>): Promise<Resultado> {
  return llamarCon(porHttp, name, args);
}

function ok(resultado: Resultado): Record<string, unknown> {
  expect(resultado.isError, resultado.texto).toBe(false);
  return resultado.json;
}

function error(resultado: Resultado): Record<string, unknown> {
  expect(resultado.isError, resultado.texto).toBe(true);
  return resultado.json["error"] as Record<string, unknown>;
}

/** Las lineas que dejo `HttpPort`, en orden. */
function peticionesHttp(): CamposDeLog[] {
  return lineas.filter((linea) => linea.campos["evt"] === "http.request").map((l) => l.campos);
}

/** Las cuatro de la 4.3, en el orden en que las crea el nucleo. */
const COLUMNAS_POR_DEFECTO = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE"];

/** El `id` de un objeto del bloque JSON de la 8.5. */
function idDe(objeto: unknown): string {
  return (objeto as Record<string, unknown>)["id"] as string;
}

async function tablero(name = "Tablero"): Promise<BoardDetail> {
  return sembrarTablero(taskman, { name });
}

function columna(detalle: BoardDetail, key: string): string {
  const encontrada = detalle.columns.find((candidata) => candidata.key === key);
  if (encontrada === undefined) {
    throw new Error(`El tablero sembrado no tiene columna ${key}.`);
  }
  return encontrada.id;
}

// --- 1. Las once herramientas ------------------------------------------------

/**
 * UNA POR UNA Y NO UNA MUESTRA. Cada herramienta llega al servidor por un
 * endpoint distinto —o por una combinacion distinta de endpoints— asi que probar
 * tres y suponer las otras ocho es suponer justamente lo que puede fallar: un
 * verbo mal escrito, una ruta con el id en el cuerpo, un campo que no se
 * traduce.
 *
 * El EFECTO de cada escritura se comprueba con `CorePort`, o sea leyendo la base
 * por el otro camino. Preguntarle al mismo HttpPort que acaba de escribir seria
 * preguntarle al acusado: si su traduccion de salida y la de entrada estuvieran
 * mal de forma simetrica, el test pasaria igual.
 */
describe("las once herramientas de la 8.2, por HttpPort contra el servidor", () => {
  it("list_boards lista los tableros", async () => {
    await tablero("Uno");
    await tablero("Dos");

    const salida = ok(await llamar("list_boards", {}));

    expect((salida["boards"] as Array<{ name: string }>).map((b) => b.name).sort()).toEqual([
      "Dos",
      "Uno",
    ]);
  });

  it("get_board trae las columnas de la 4.3 con su recuento", async () => {
    const detalle = await tablero("QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "una" }, ctx());

    const salida = ok(await llamar("get_board", { board: "QA" }));
    const columnas = salida["columns"] as Array<{ key: string; task_count: number }>;

    expect(columnas.map((c) => c.key)).toEqual(COLUMNAS_POR_DEFECTO);
    expect(columnas.find((c) => c.key === "TODO")?.task_count).toBe(1);
  });

  it("create_board crea el tablero con sus cuatro columnas", async () => {
    const salida = ok(await llamar("create_board", { name: "Nuevo" }));

    const creado = await taskman.getBoard(idDe(salida["board"]));
    expect(creado.name).toBe("Nuevo");
    expect(creado.columns.map((c) => c.key)).toEqual(COLUMNAS_POR_DEFECTO);
  });

  it("create_column agrega una columna al tablero", async () => {
    const detalle = await tablero("QA");

    ok(await llamar("create_column", { board: "QA", name: "En revision", key: "REVIEW" }));

    const releido = await taskman.getBoard(detalle.id);
    expect(releido.columns.map((c) => c.key)).toContain("REVIEW");
  });

  it("list_tasks lista las tareas de una columna", async () => {
    const detalle = await tablero("QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "en todo" }, ctx());
    await taskman.createTask({ boardId: detalle.id, columnKey: "DONE", title: "en done" }, ctx());

    const salida = ok(await llamar("list_tasks", { board: "QA", column: "TODO" }));

    expect((salida["tasks"] as Array<{ title: string }>).map((t) => t.title)).toEqual(["en todo"]);
  });

  it("search_tasks encuentra por texto, tambien sin tablero", async () => {
    const uno = await tablero("Uno");
    const dos = await tablero("Dos");
    await taskman.createTask({ boardId: uno.id, columnKey: "TODO", title: "Revisar contrato" }, ctx());
    await taskman.createTask({ boardId: dos.id, columnKey: "TODO", title: "Firmar contrato" }, ctx());

    const salida = ok(await llamar("search_tasks", { text: "contrato" }));

    expect((salida["tasks"] as Array<{ title: string }>).map((t) => t.title).sort()).toEqual([
      "Firmar contrato",
      "Revisar contrato",
    ]);
  });

  it("get_task devuelve la tarea con su columna", async () => {
    const detalle = await tablero("QA");
    const tarea = await taskman.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "Revisar HU-25", description: "el detalle" },
      ctx(),
    );

    const salida = ok(await llamar("get_task", { task: tarea.id }));
    const devuelta = salida["task"] as Record<string, unknown>;

    expect(devuelta["title"]).toBe("Revisar HU-25");
    expect(devuelta["description"]).toBe("el detalle");
    expect(devuelta["column_key"]).toBe("TODO");
  });

  it("create_task crea la tarea al final de la columna", async () => {
    const detalle = await tablero("QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "primera" }, ctx());

    const salida = ok(
      await llamar("create_task", {
        board: "QA",
        column: "TODO",
        title: "segunda",
        priority: "HIGH",
        due_date: "2026-09-11",
      }),
    );

    const creada = await taskman.getTask(idDe(salida["task"]));
    expect(creada.title).toBe("segunda");
    expect(creada.priority).toBe("HIGH");
    // La fecha sin hora sobrevive el viaje de ida sin correrse de dia (6.1).
    expect(creada.dueDate?.toISOString().slice(0, 10)).toBe("2026-09-11");
    expect(creada.position).toBe(1);
  });

  it("update_task cambia los campos editables, y null borra", async () => {
    const detalle = await tablero("QA");
    const tarea = await taskman.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "vieja", description: "con descripcion" },
      ctx(),
    );

    ok(await llamar("update_task", { task: tarea.id, title: "nueva", description: null }));

    const releida = await taskman.getTask(tarea.id);
    expect(releida.title).toBe("nueva");
    expect(releida.description).toBeNull();
  });

  it("move_task mueve entre columnas y devuelve el orden final", async () => {
    const detalle = await tablero("QA");
    const tarea = await taskman.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "viajera" },
      ctx(),
    );

    const salida = ok(await llamar("move_task", { task: tarea.id, to_column: "DONE" }));

    expect((salida["to_column"] as Record<string, unknown>)["key"]).toBe("DONE");
    expect((await taskman.getTask(tarea.id)).columnId).toBe(columna(detalle, "DONE"));
  });

  it("delete_task borra tras confirmar, y sin confirmar no borra", async () => {
    const detalle = await tablero("QA");
    const tarea = await taskman.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "condenada" },
      ctx(),
    );

    // 8.3.2: el primer paso es una pregunta, no un fallo, y no toca nada.
    expect(error(await llamar("delete_task", { task: tarea.id }))["code"]).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect((await taskman.getTask(tarea.id)).title).toBe("condenada");

    ok(await llamar("delete_task", { task: tarea.id, confirm: true }));

    await expect(taskman.getTask(tarea.id)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

// --- 2. Equivalencia con el modo core ----------------------------------------

/**
 * El mismo caso por las dos puertas, y la comparacion campo por campo.
 *
 * HAY DOS CLASES DE ERROR DE DOMINIO EN MODO HTTP y conviene no confundirlas,
 * porque se comportan distinto y las dos tienen que estar medidas:
 *
 * - Los que se producen EN ESTE PROCESO. AMBIGUOUS_MATCH es el ejemplo: lo lanza
 *   `resolverReferencia` del nucleo, que corre igual en los dos modos. No cruza
 *   el cable, asi que no se traduce nada y el error tiene que ser IDENTICO. Lo
 *   que mide es la traduccion de DATOS: los candidatos salen de `list_tasks` por
 *   HTTP, con sus ids, sus titulos y su columna.
 * - Los que se producen EN EL SERVIDOR y vuelven en la envoltura de la 6.4.
 *   BOARD_NOT_FOUND es el ejemplo. Ahi si hay traduccion, y la unica diferencia
 *   admitida es `details.request_id`, que es O4.
 */
describe("un error de dominio se ve igual por las dos puertas", () => {
  it("AMBIGUOUS_MATCH es IDENTICO: mismo codigo, mismos candidatos y mismo hint", async () => {
    const detalle = await tablero("QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "Revisar" }, ctx());
    await taskman.createTask({ boardId: detalle.id, columnKey: "DONE", title: "Revisar" }, ctx());

    const args = { board: "QA", task: "Revisar" };
    const conHttp = error(await llamarCon(porHttp, "get_task", args));
    const conCore = error(await llamarCon(porCore, "get_task", args));

    expect(conHttp["code"]).toBe("AMBIGUOUS_MATCH");
    // El `request_id` de la envoltura es de la invocacion y cambia en cada
    // llamada, tambien entre dos llamadas al mismo puerto: se quita de los dos.
    expect(sinRequestId(conHttp)).toEqual(sinRequestId(conCore));
    // Y lo que hace util a este error esta de verdad ahi, no es un objeto vacio
    // comparado con otro objeto vacio.
    const candidatos = (conHttp["details"] as { candidates: unknown[] }).candidates;
    expect(candidatos).toHaveLength(2);
    expect(conHttp["hint"]).toEqual(expect.stringContaining("id"));
  });

  it("BOARD_NOT_FOUND cruza el cable y vuelve igual, MAS el request_id del servidor", async () => {
    const inexistente = "00000000-0000-4000-8000-000000000000";

    const conHttp = error(await llamarCon(porHttp, "get_board", { board: inexistente }));
    const conCore = error(await llamarCon(porCore, "get_board", { board: inexistente }));

    expect(conHttp["code"]).toBe("BOARD_NOT_FOUND");
    expect(conHttp["message"]).toBe(conCore["message"]);

    const detallesHttp = conHttp["details"] as Record<string, unknown>;
    const detallesCore = conCore["details"] as Record<string, unknown>;

    // O4: lo UNICO que agrega el modo http es el id con el que el servidor
    // registro la peticion que fallo.
    const { request_id: idDelServidor, ...resto } = detallesHttp;
    expect(resto).toEqual(detallesCore);
    expect(idDelServidor).toEqual(expect.stringMatching(/^req_[0-9a-f]{32}$/));

    // Y es el de VERDAD: el mismo que vino en la cabecera X-Request-Id de la
    // respuesta 404, no uno inventado de este lado.
    const ultima = peticionesHttp().at(-1);
    expect(ultima?.["status"]).toBe(404);
    expect(ultima?.["serverRequestId"]).toBe(idDelServidor);
    // Y NO es el id local, que es de este proceso.
    expect(ultima?.["requestId"]).not.toBe(idDelServidor);
  });
});

/** La envoltura sin el `request_id` de la invocacion, que cambia siempre. */
function sinRequestId(error: Record<string, unknown>): Record<string, unknown> {
  const { request_id: _ignorado, ...resto } = error;
  return resto;
}

// --- 3, 4 y 5. Lo que el servidor produce y el nucleo no ----------------------

describe("los codigos que produce el borde REST llegan al agente con su significado", () => {
  it("un 429 NO dice que reintentar probablemente falle: dice cuanto esperar", async () => {
    process.env["RATE_LIMIT_ENABLED"] = "true";
    reiniciarLimiteDePeticiones();

    try {
      // El cupo de escritura de la 7.3 se agota por el puerto, sin pasar por las
      // herramientas: lo que se mide es la ultima llamada, no estas.
      for (let i = 0; i < LIMITE_POR_CUBO["escritura"]; i += 1) {
        await httpPort.createBoard({ name: `tablero ${i}` }, ctx());
      }

      const cuerpo = error(await llamar("create_board", { name: "el que sobra" }));

      expect(cuerpo["code"]).toBe("RATE_LIMITED");
      expect(cuerpo["hint"]).toEqual(expect.stringContaining("reintenta"));
      // La frase del INTERNAL_ERROR del ejecutor, que para un 429 es FALSA.
      expect(JSON.stringify(cuerpo)).not.toContain("probablemente vuelva a fallar");
      expect(cuerpo["code"]).not.toBe("INTERNAL_ERROR");

      // Y trae con que ajustar el ritmo sin ir a leer la especificacion.
      const detalles = cuerpo["details"] as Record<string, unknown>;
      expect(detalles["bucket"]).toBe("write");
      expect(detalles["limit"]).toBe(LIMITE_POR_CUBO["escritura"]);
      expect(detalles["retry_after_seconds"]).toEqual(expect.any(Number));
      expect(detalles["request_id"]).toEqual(expect.stringMatching(/^req_/));
    } finally {
      process.env["RATE_LIMIT_ENABLED"] = "false";
      reiniciarLimiteDePeticiones();
    }
  });

  it("una clave sin el scope ve QUE scope le falta, no un error interno", async () => {
    const detalle = await tablero("QA");
    const soloLectura = await conectar(
      new HttpPort({ baseUrl: servidor.url, apiKey: claveLectura, logger: loggerCapturador() }),
    );

    try {
      // La lectura si pasa: la clave tiene READ.
      ok(await llamarCon(soloLectura, "get_board", { board: "QA" }));

      const cuerpo = error(
        await llamarCon(soloLectura, "create_task", { board: "QA", column: "TODO", title: "no va" }),
      );

      expect(cuerpo["code"]).toBe("FORBIDDEN_SCOPE");
      expect(cuerpo["details"]).toMatchObject({
        required_scope: "write",
        granted_scopes: ["read"],
      });
      expect(cuerpo["hint"]).toEqual(expect.stringContaining("clave"));
      expect(JSON.stringify(cuerpo)).not.toContain("probablemente vuelva a fallar");

      // Y no escribio nada, que es lo que el 403 promete.
      expect((await taskman.listTasks({ boardId: detalle.id })).items).toHaveLength(0);
    } finally {
      await soloLectura.close();
    }
  });

  it("un 401 llega como UNAUTHENTICATED y no como fallo no controlado", async () => {
    const conClaveMala = await conectar(
      new HttpPort({ baseUrl: servidor.url, apiKey: "tmk_live_noexiste", logger: loggerCapturador() }),
    );

    try {
      const cuerpo = error(await llamarCon(conClaveMala, "list_boards", {}));

      expect(cuerpo["code"]).toBe("UNAUTHENTICATED");
      expect(cuerpo["hint"]).toEqual(expect.stringContaining("Bearer"));
    } finally {
      await conClaveMala.close();
    }
  });

  it("un codigo que este proceso no conoce sube como fallo inesperado, con el id del servidor", async () => {
    /**
     * La contraparte de los cuatro que SI se traducen. Se provoca con un cuerpo
     * de error que no es ninguno del catalogo: lo que tiene que pasar es que NO
     * se disfrace de error de dominio —el agente no puede corregir lo que no
     * entiende— y que el id del servidor quede en la traza para poder buscar la
     * otra punta.
     */
    const inventado = new HttpPort({
      baseUrl: servidor.url,
      apiKey: claveCompleta,
      logger: loggerCapturador(),
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "TELEPORT_FAILED",
              message: "Un codigo del futuro.",
              request_id: "req_delservidor",
            },
          }),
          { status: 418, headers: { "X-Request-Id": "req_delservidor" } },
        ),
    });

    await expect(inventado.getBoard("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      /TELEPORT_FAILED.*req_delservidor/s,
    );

    // Y por el borde MCP el agente lo ve como INTERNAL_ERROR, que es lo que es.
    const cliente = await conectar(inventado);
    try {
      const cuerpo = error(await llamarCon(cliente, "list_boards", {}));
      expect(cuerpo["code"]).toBe("INTERNAL_ERROR");
      // Sin la causa, como cualquier fallo no controlado (6.4).
      expect(JSON.stringify(cuerpo)).not.toContain("TELEPORT_FAILED");
    } finally {
      await cliente.close();
    }
  });
});

// --- 3b. El actor de la auditoria, O2 del paso 12 ----------------------------

describe("O2: lo que entra por HttpPort audita AGENT", () => {
  /**
   * EL PASO 12 EN UNA PRUEBA. `HttpPort` es un cliente REST como cualquier otro:
   * el servidor no puede distinguir su POST del de curl, asi que "por donde
   * entro" —lo que la 7.4 manda derivar— no es observable en el borde. Lo que
   * si es observable es CON QUE CLAVE entro, y esa la emite quien administra.
   *
   * Por eso las dos mitades de este describe van juntas: con una clave de
   * agente el mismo cliente audita AGENT, y con una normal audita API. La
   * diferencia esta enteramente en la credencial, y no hay nada que el proceso
   * pueda mandar para moverla.
   */
  async function actorDeLaTarea(titulo: string): Promise<string | undefined> {
    const filas = await db.query<{ actor_type: string }>(
      `SELECT a.actor_type::text AS actor_type
         FROM audit_log a JOIN task t ON t.id::text = a.entity_id
        WHERE a.entity_type = 'task' AND t.title = $1
        ORDER BY a.id DESC LIMIT 1`,
      [titulo],
    );
    return filas.rows[0]?.actor_type;
  }

  function puertoCon(apiKey: string): HttpPort {
    return new HttpPort({ baseUrl: servidor.url, apiKey, logger: loggerCapturador() });
  }

  it("con una clave emitida como agente, una escritura queda AGENT", async () => {
    const claveAgente = await emitirClave(db, ["READ", "WRITE"], {
      label: "stdio remoto",
      agente: true,
    });
    const detalle = await tablero("QA");

    await puertoCon(claveAgente).createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "escrita por el agente" },
      ctx(),
    );

    expect(await actorDeLaTarea("escrita por el agente")).toBe("AGENT");
  });

  it("con la clave normal de la suite, la MISMA escritura queda API", async () => {
    // La contraprueba de la de arriba: mismo cliente, mismo endpoint, mismo
    // cuerpo. Lo unico distinto es la clave, que es justamente lo que se quiso.
    const detalle = await tablero("QA");

    await httpPort.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "escrita por un cliente REST" },
      ctx(),
    );

    expect(await actorDeLaTarea("escrita por un cliente REST")).toBe("API");
  });

  it("el `ctx` del agente no lo mueve: el actor no viaja en la peticion", async () => {
    // `TaskManagerPort` recibe un ActorContext y HttpPort NO lo manda (ver la
    // nota de `createBoard` en http-port.ts). Aunque el proceso local se arme un
    // contexto que diga AGENT, lo que queda escrito lo decide la clave. Es la
    // misma propiedad que O4 fija para el request_id, sobre el otro campo.
    const detalle = await tablero("QA");

    await httpPort.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "con ctx de agente" },
      { ...ctx(), actorType: "AGENT", actorName: "me-declaro-agente" },
    );

    expect(await actorDeLaTarea("con ctx de agente")).toBe("API");

    const filas = await db.query<{ actor_name: string }>(
      `SELECT a.actor_name FROM audit_log a JOIN task t ON t.id::text = a.entity_id
        WHERE t.title = $1 ORDER BY a.id DESC LIMIT 1`,
      ["con ctx de agente"],
    );
    expect(filas.rows[0]?.actor_name).toBe("clave de HttpPort");
    expect(filas.rows[0]?.actor_name).not.toBe("me-declaro-agente");
  });
});

// --- 4. El request_id, las dos mitades de O4 ---------------------------------

describe("O4: el request_id del servidor", () => {
  it("NO se manda el del agente: el servidor genera el suyo y es el que vuelve", async () => {
    const detalle = await tablero("QA");
    const contexto = ctx();

    await httpPort.createTask(
      { boardId: detalle.id, columnKey: "TODO", title: "auditada" },
      contexto,
    );

    const escritura = peticionesHttp().find((campos) => campos["method"] === "POST");
    const idServidor = escritura?.["serverRequestId"];

    // Lo que quedo en la auditoria es el id del SERVIDOR, no el del agente: si
    // se mandara, un cliente elegiria lo que queda escrito en `audit_log`.
    const filas = await db.query<{ request_id: string }>(
      `SELECT request_id FROM audit_log WHERE entity_type = 'task' ORDER BY id DESC LIMIT 1`,
    );

    expect(filas.rows[0]?.request_id).toBe(idServidor);
    expect(filas.rows[0]?.request_id).not.toBe(contexto.requestId);
  });

  it("la linea por peticion empareja el id local, el del servidor y el de la invocacion", async () => {
    const detalle = await tablero("QA");
    const contexto = ctx();

    await httpPort.createTask({ boardId: detalle.id, columnKey: "TODO", title: "t" }, contexto);

    const linea = peticionesHttp().at(-1);

    expect(linea).toMatchObject({
      evt: "http.request",
      method: "POST",
      route: "/api/tasks",
      status: 201,
      // El de la invocacion MCP: el mismo que lleva la linea `mcp.tool`.
      toolRequestId: contexto.requestId,
    });
    expect(linea?.["requestId"]).toEqual(expect.stringMatching(/^req_[0-9a-f]{32}$/));
    expect(linea?.["serverRequestId"]).toEqual(expect.stringMatching(/^req_[0-9a-f]{32}$/));
    expect(linea?.["requestId"]).not.toBe(linea?.["serverRequestId"]);
    expect(linea?.["durationMs"]).toEqual(expect.any(Number));
  });

  it("una LECTURA tambien empareja los dos ids, aunque no lleve el de la invocacion", async () => {
    // Las lecturas no reciben `ActorContext` (7.4), asi que no hay
    // `toolRequestId` que poner. Los dos ids que emparejan la peticion con la
    // del servidor si estan, que es lo que O4 pide.
    await tablero("QA");
    await httpPort.listBoards({ limit: 10 });

    const linea = peticionesHttp().at(-1);

    expect(linea?.["method"]).toBe("GET");
    expect(linea?.["serverRequestId"]).toEqual(expect.stringMatching(/^req_/));
    expect(linea?.["toolRequestId"]).toBeUndefined();
  });
});

// --- 6. Resolucion por nombre ------------------------------------------------

/**
 * El camino que mas peticiones encadena: resolver un tablero por nombre son
 * `list_boards` mas `get_board`, y resolver una tarea por titulo suma un
 * `list_tasks` del tablero entero. Si algo se pierde en la traduccion —un id,
 * una key, el cursor de la paginacion— se nota aca antes que en ningun otro
 * lado.
 */
describe("la resolucion por nombre de la 8.3.1 sobrevive al viaje", () => {
  it("mueve una tarea nombrando el tablero, la tarea y la columna por su nombre", async () => {
    const detalle = await tablero("Tablero de QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "Revisar HU-25" }, ctx());

    const salida = ok(
      await llamar("move_task", {
        board: "Tablero de QA",
        task: "Revisar HU-25",
        to_column: "En progreso",
      }),
    );

    expect((salida["to_column"] as Record<string, unknown>)["key"]).toBe("IN_PROGRESS");

    const releida = (await taskman.listTasks({ boardId: detalle.id })).items[0];
    expect(releida?.columnId).toBe(columna(detalle, "IN_PROGRESS"));
  });

  it("un nombre que no existe da el mismo NOT_FOUND que en modo core", async () => {
    await tablero("QA");

    const args = { board: "El que no esta" };
    const conHttp = error(await llamarCon(porHttp, "get_board", args));
    const conCore = error(await llamarCon(porCore, "get_board", args));

    expect(conHttp["code"]).toBe("BOARD_NOT_FOUND");
    // Se resuelve en este proceso —enumerando por HTTP— asi que es identico.
    expect(sinRequestId(conHttp)).toEqual(sinRequestId(conCore));
  });

  it("enumera TODAS las paginas para resolver, no solo la primera", async () => {
    /**
     * `cargarTablero` recolecta con el cursor hasta agotar (`recolectar`). Con un
     * puerto HTTP eso son varias peticiones encadenadas por `next_cursor`, y un
     * cursor que no se propagara dejaria la resolucion mirando siempre la primera
     * pagina: el tablero numero 4 no se encontraria nunca.
     */
    for (let i = 0; i < 4; i += 1) {
      await tablero(`Tablero ${i}`);
    }

    const acotado = new HttpPort({
      baseUrl: servidor.url,
      apiKey: claveCompleta,
      logger: loggerCapturador(),
    });

    // Se pide de a uno para forzar la paginacion: el puerto tiene que seguir el
    // cursor hasta la ultima pagina.
    const primera = await acotado.listBoards({ limit: 1 });
    expect(primera.items).toHaveLength(1);
    expect(primera.nextCursor).not.toBeNull();

    const segunda = await acotado.listBoards({ limit: 1, cursor: primera.nextCursor ?? "" });
    expect(segunda.items[0]?.id).not.toBe(primera.items[0]?.id);

    // Y por el borde, el ultimo tablero se resuelve por nombre igual.
    const encontrado = ok(await llamar("get_board", { board: "Tablero 3" }));
    expect((encontrado["board"] as Record<string, unknown>)["name"]).toBe("Tablero 3");
  });
});

// --- Lo que el puerto devuelve, visto sin el borde ---------------------------

describe("el puerto devuelve tipos del dominio, no la forma del borde", () => {
  it("las fechas vuelven como Date y los campos en camelCase", async () => {
    const detalle = await tablero("QA");
    const creada = await httpPort.createTask(
      {
        boardId: detalle.id,
        columnKey: "TODO",
        title: "con fecha",
        dueDate: new Date("2026-09-11T00:00:00.000Z"),
      },
      ctx(),
    );

    expect(creada.createdAt).toBeInstanceOf(Date);
    expect(creada.dueDate).toBeInstanceOf(Date);
    expect(creada.dueDate?.toISOString()).toBe("2026-09-11T00:00:00.000Z");
    expect(creada.boardId).toBe(detalle.id);

    // Y es exactamente lo que devuelve el otro puerto para la misma tarea.
    expect(creada).toEqual(await taskman.getTask(creada.id));
  });

  it("un DomainError del servidor es un DomainError de verdad, no un Error cualquiera", async () => {
    let capturado: unknown;

    try {
      await httpPort.getTask("00000000-0000-4000-8000-000000000000");
    } catch (error: unknown) {
      capturado = error;
    }

    expect(isDomainError(capturado)).toBe(true);
    expect((capturado as DomainError).code).toBe("TASK_NOT_FOUND");
  });

  it("falla al construir si falta la URL o la clave, no en la primera llamada", () => {
    expect(() => new HttpPort({ baseUrl: "", apiKey: "k" })).toThrow(/TASKMAN_API_URL/);
    expect(() => new HttpPort({ baseUrl: "http://x", apiKey: "  " })).toThrow(/TASKMAN_API_KEY/);
  });
});

// --- 7. Los scopes de la clave, y el catalogo que producen -------------------

/**
 * EL FILTRADO DEL CATALOGO DE LA 8.1 EN MODO HTTP: "un cliente MCP sin scope
 * delete no ve disponible la herramienta delete_task: el filtrado ocurre en el
 * listado de herramientas, no solo en la ejecucion, para que el agente no
 * planifique acciones que no puede completar".
 *
 * Ese DEBE ya se cumplia en /mcp, que lee los scopes de la fila de la clave que
 * autentico. Por stdio en modo http no hay fila que leer —este proceso solo
 * tiene la clave en claro— asi que los scopes se MIDEN contra el servidor con
 * tres sondas. El razonamiento de por que sondear y no agregar un endpoint de
 * introspeccion esta entero en `descubrirScopes`; lo que se mide aca es que el
 * mecanismo da la respuesta correcta y que no toca nada al darla.
 *
 * VA CONTRA EL SERVIDOR DE VERDAD, como el resto de la suite: lo que se afirma
 * es una relacion entre lo que `conAuth` responde y lo que el catalogo muestra,
 * y un doble de `fetch` afirmaria lo que el doble diga.
 */
describe("los scopes de la clave, medidos contra el servidor (8.1)", () => {
  function puertoCon(clave: string): HttpPort {
    return new HttpPort({ baseUrl: servidor.url, apiKey: clave, logger: loggerCapturador() });
  }

  async function herramientasDe(clave: string): Promise<string[]> {
    const puerto = puertoCon(clave);
    const { scopes } = await puerto.descubrirScopes();
    const cliente = await conectar(puerto, scopes);

    try {
      return (await cliente.listTools()).tools.map((herramienta) => herramienta.name);
    } finally {
      await cliente.close();
    }
  }

  it("una clave con los tres scopes los devuelve los tres, sin nada sin medir", async () => {
    expect(await puertoCon(claveCompleta).descubrirScopes()).toEqual({
      scopes: ["READ", "WRITE", "DELETE"],
      indeterminados: [],
    });
  });

  it("una clave de solo lectura devuelve solo read", async () => {
    expect(await puertoCon(claveLectura).descubrirScopes()).toEqual({
      scopes: ["READ"],
      indeterminados: [],
    });
  });

  it("CON UNA CLAVE SIN delete, delete_task NO APARECE EN EL LISTADO", async () => {
    const sinBorrado = await emitirClave(db, ["READ", "WRITE"], { label: "agente sin borrado" });

    const conBorrado = await herramientasDe(claveCompleta);
    const nombres = await herramientasDe(sinBorrado);

    // Las once menos una, y la que falta es la que la clave no puede usar.
    expect(conBorrado).toContain("delete_task");
    expect(conBorrado).toHaveLength(11);
    expect(nombres).not.toContain("delete_task");
    expect(nombres).toHaveLength(10);

    // Y el resto del catalogo esta entero: lo que se recorta es un scope, no
    // una lista escrita a mano.
    expect(nombres).toEqual(conBorrado.filter((nombre) => nombre !== "delete_task"));
  });

  it("una clave de solo lectura ve las cinco de lectura y ninguna que escriba", async () => {
    expect(await herramientasDe(claveLectura)).toEqual([
      "list_boards",
      "get_board",
      "list_tasks",
      "search_tasks",
      "get_task",
    ]);
  });

  it("sondear NO ESCRIBE NADA: ni tareas, ni tableros, ni auditoria", async () => {
    /**
     * La propiedad que hace aceptable sondear con un DELETE. El id de la sonda
     * no es un UUID, asi que los tres handlers lo rechazan con 400 antes de
     * mirar la base: no es improbable que borre algo, es imposible.
     */
    const detalle = await tablero("QA");
    await taskman.createTask({ boardId: detalle.id, columnKey: "TODO", title: "no se toca" }, ctx());

    const tableros = await contarFilas(db, "board");
    const tareas = await contarFilas(db, "task");
    const auditoria = await contarFilas(db, "audit_log");

    await puertoCon(claveCompleta).descubrirScopes();

    expect(await contarFilas(db, "board")).toBe(tableros);
    expect(await contarFilas(db, "task")).toBe(tareas);
    expect(await contarFilas(db, "audit_log")).toBe(auditoria);

    // Las tres sondas ocurrieron, sobre el mismo recurso y con los tres verbos:
    // si alguna se hubiera saltado, el conteo de arriba pasaria por no hacer
    // nada en vez de por no poder hacer nada.
    const sondas = peticionesHttp().filter((linea) => linea["route"] === "/api/tasks/sonda-de-scope");
    expect(sondas.map((linea) => linea["method"])).toEqual(["GET", "PATCH", "DELETE"]);
    expect(sondas.map((linea) => linea["status"])).toEqual([400, 400, 400]);
  });

  it("una clave que el servidor rechaza NO deja arrancar, nombrando la variable", async () => {
    // Es el caso que vale la pena separar de "no se pudo medir": el servidor
    // contesto, y contesto que la clave no sirve. Arrancar igual daria un
    // servidor MCP que anuncia once herramientas y falla las once.
    await expect(puertoCon("tmk_live_noexiste").descubrirScopes()).rejects.toThrow(
      /TASKMAN_API_KEY/,
    );
  });

  it("una clave revocada es el mismo caso que una que no existe", async () => {
    const revocada = await emitirClave(db, ["READ", "WRITE"], { revocada: true });

    await expect(puertoCon(revocada).descubrirScopes()).rejects.toThrow(/401/);
  });

  it("lo que no se puede medir se da por concedido, y se dice cual", async () => {
    /**
     * La direccion correcta del error: el agente vuelve a ver la herramienta y
     * a recibir el 403 al ejecutarla —el comportamiento de antes de este paso—
     * en vez de perder herramientas que si tenia porque el servidor tosio.
     *
     * Se provoca con un `fetch` que contesta 500 al PATCH y deja pasar el resto:
     * un 500 puede venir del handler o de antes de autenticar, asi que no dice
     * nada sobre el scope.
     */
    const real = globalThis.fetch;
    const conCaida = new HttpPort({
      baseUrl: servidor.url,
      apiKey: claveLectura,
      logger: loggerCapturador(),
      fetch: async (entrada, init) =>
        init?.method === "PATCH"
          ? new Response(
              JSON.stringify({
                error: { code: "INTERNAL_ERROR", message: "se cayo", request_id: "req_x" },
              }),
              { status: 500, headers: { "X-Request-Id": "req_x" } },
            )
          : real(entrada, init),
    });

    // La clave es de solo lectura: `write` se le concede sin haberlo medido, y
    // `delete` —que si se pudo medir— sigue fuera.
    expect(await conCaida.descubrirScopes()).toEqual({
      scopes: ["READ", "WRITE"],
      indeterminados: ["WRITE"],
    });
  });
});
