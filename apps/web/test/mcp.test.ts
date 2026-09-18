import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CorePort, prefijoDe, type CamposDeLog, type Logger } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "../app/mcp/route";
import { LIMITE_CUERPO_BYTES } from "../lib/http";
import { fijarLogger } from "../lib/log";
import { LIMITE_POR_CUBO, reiniciarLimiteDePeticiones } from "../lib/rate-limit";
import {
  COLUMNAS_POR_DEFECTO,
  connectDb,
  ctx,
  emitirClave,
  error,
  idDe,
  llamarCon,
  ok,
  port,
  sembrarTablero,
  sembrarTareas,
  truncateAll,
  type Resultado,
} from "./helpers";

/**
 * /mcp (8.1): el transporte Streamable HTTP, autenticado por API key y con los
 * scopes de la clave aplicados.
 *
 * El cliente es EL DE LA SDK, con su `StreamableHTTPClientTransport`, y no
 * peticiones armadas a mano: lo que decide si /mcp sirve es que un cliente real
 * negocie el initialize, liste y llame. Lo unico que se reemplaza es la red —el
 * `fetch` del transporte invoca el Route Handler en el mismo proceso—, igual que
 * el resto de la suite invoca los handlers de /api sin levantar un servidor. El
 * cliente contra `next start` de verdad se mide aparte.
 *
 * Los casos que miran cabeceras y correlacion van con JSON-RPC crudo, porque ahi
 * lo que importa es la respuesta HTTP de UN mensaje, y el cliente las oculta.
 */

const URL_MCP = "http://taskman.test/mcp";

/** Las once de la 8.2. */
const ONCE = [
  "create_board",
  "create_column",
  "create_task",
  "delete_task",
  "get_board",
  "get_task",
  "list_boards",
  "list_tasks",
  "move_task",
  "search_tasks",
  "update_task",
];

const LECTURA = ["get_board", "get_task", "list_boards", "list_tasks", "search_tasks"];

interface LineaCapturada {
  readonly campos: CamposDeLog;
  readonly mensaje: string;
}

let db: Client;
let lineas: LineaCapturada[];

beforeAll(async () => {
  db = await connectDb();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);

  lineas = [];
  const anotar = (campos: CamposDeLog, mensaje: string): void => {
    lineas.push({ campos, mensaje });
  };
  const logger: Logger = { debug: anotar, info: anotar, warn: anotar, error: anotar };
  fijarLogger(logger);
});

afterEach(() => {
  fijarLogger(undefined);
  delete process.env["MCP_DESTRUCTIVE_POLICY"];
});

/** El `fetch` del transporte del cliente, contra el Route Handler. */
async function alRouteHandler(url: string | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(url, init);

  switch (request.method) {
    case "POST":
      return POST(request);
    case "GET":
      return GET(request);
    case "DELETE":
      return DELETE(request);
    default:
      throw new Error(`Metodo inesperado en la prueba: ${request.method}`);
  }
}

function transporte(clave: string | undefined): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(URL_MCP), {
    fetch: alRouteHandler,
    ...(clave === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${clave}` } } }),
  });
}

async function conectar(clave: string | undefined): Promise<McpClient> {
  const cliente = new McpClient({ name: "prueba-http", version: "0.0.0" });
  // El cast es por el SDK y no por la prueba: su propio transporte declara
  // `sessionId: string | undefined` y su `Transport` pide `sessionId?: string`,
  // que con `exactOptionalPropertyTypes` no son lo mismo (TS2379).
  await cliente.connect(transporte(clave) as Transport);
  return cliente;
}

async function nombres(cliente: McpClient): Promise<string[]> {
  return (await cliente.listTools()).tools.map((herramienta) => herramienta.name).sort();
}

/** Un mensaje JSON-RPC suelto, sin initialize: /mcp no tiene sesion. */
function mensaje(
  clave: string | undefined,
  method: string,
  params: Record<string, unknown>,
  metodoHttp: "POST" | "GET" | "DELETE" = "POST",
): Request {
  const headers = new Headers({ accept: "application/json, text/event-stream" });
  if (clave !== undefined) {
    headers.set("authorization", `Bearer ${clave}`);
  }
  if (metodoHttp !== "POST") {
    return new Request(URL_MCP, { method: metodoHttp, headers });
  }
  headers.set("content-type", "application/json");
  return new Request(URL_MCP, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** La linea por peticion de la 11.1: la unica con mensaje "peticion". */
function lineasDePeticion(): CamposDeLog[] {
  return lineas.filter((linea) => linea.mensaje === "peticion").map((linea) => linea.campos);
}

describe("/mcp sin clave valida", () => {
  it("sin Authorization: 401 con la envoltura de la 6.4, su X-Request-Id y su linea AGENT", async () => {
    const respuesta = await POST(mensaje(undefined, "tools/list", {}));

    expect(respuesta.status).toBe(401);
    const requestId = respuesta.headers.get("x-request-id");
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/);

    const cuerpo = (await respuesta.json()) as { error: { code: string; request_id: string } };
    expect(cuerpo.error.code).toBe("UNAUTHENTICATED");
    expect(cuerpo.error.request_id).toBe(requestId);
    // RFC 7235: el desafio, el mismo que /api.
    expect(respuesta.headers.get("www-authenticate")).toBe('Bearer realm="taskman"');

    expect(lineasDePeticion()).toEqual([
      expect.objectContaining({
        request_id: requestId,
        method: "POST",
        route: "/mcp",
        status: 401,
        client_id: null,
        actor_type: "AGENT",
      }),
    ]);
  });

  it("el cliente de la SDK no conecta, y el error trae el 401 y el codigo", async () => {
    const intento = conectar(undefined);

    await expect(intento).rejects.toMatchObject({ code: 401 });
    await expect(intento).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it("una clave revocada tampoco: el mismo 401", async () => {
    const revocada = await emitirClave(db, ["READ", "WRITE", "DELETE"], { revocada: true });

    const respuesta = await POST(mensaje(revocada, "tools/list", {}));

    expect(respuesta.status).toBe(401);
    expect(((await respuesta.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("GET y DELETE sin clave tambien pasan por la autenticacion: 401", async () => {
    expect((await GET(mensaje(undefined, "", {}, "GET"))).status).toBe(401);
    expect((await DELETE(mensaje(undefined, "", {}, "DELETE"))).status).toBe(401);
  });
});

describe("/mcp con clave: los scopes deciden el catalogo (8.1)", () => {
  it("con los tres scopes, las once; y una llamada real escribe en la base", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE", "DELETE"], { label: "agente remoto" });
    const cliente = await conectar(clave);

    expect(await nombres(cliente)).toEqual(ONCE);

    const creado = await cliente.callTool({ name: "create_board", arguments: { name: "Remoto" } });
    expect(creado.isError).toBeFalsy();

    const tableros = await db.query<{ name: string }>("SELECT name FROM board");
    expect(tableros.rows).toEqual([{ name: "Remoto" }]);

    await cliente.close();
  });

  it("sin delete, diez: delete_task no esta, y llamarla no llega a ningun handler", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE"]);
    const cliente = await conectar(clave);

    const disponibles = await nombres(cliente);
    expect(disponibles).toHaveLength(10);
    expect(disponibles).not.toContain("delete_task");

    const llamada = await cliente.callTool({
      name: "delete_task",
      arguments: { task: "cualquiera", confirm: true },
    });
    expect(llamada.isError).toBe(true);
    expect(JSON.stringify(llamada.content)).toContain("not found");

    await cliente.close();
  });

  it("un argumento que la herramienta no declara se rechaza por /mcp nombrandolo, y el listado lo anuncia", async () => {
    // El mismo caso que motivo el cambio, por el otro transporte: antes el SDK
    // envolvia el esquema en un `z.object` no estricto y `status` moria en
    // silencio, asi que /mcp devolvia las dos tareas como si hubiera filtrado.
    const tablero = await sembrarTablero(port(), { name: "Remoto" });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "TODO", prefijo: "pendiente", cantidad: 1 });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "DONE", prefijo: "hecha", cantidad: 1 });
    const cliente = await conectar(await emitirClave(db, ["READ"]));

    const rechazo = await cliente.callTool({
      name: "list_tasks",
      arguments: { board: "Remoto", status: "DONE" },
    });
    expect(rechazo.isError).toBe(true);
    const texto = JSON.stringify(rechazo.content);
    expect(texto).toContain("status");
    expect(texto).not.toContain("pendiente");
    expect(texto).not.toContain("hecha");

    // Sin el argumento, la misma llamada ejecuta: lo rechazado era la clave.
    const aceptada = await cliente.callTool({ name: "list_tasks", arguments: { board: "Remoto" } });
    expect(aceptada.isError).toBeFalsy();
    expect(JSON.stringify(aceptada.content)).toContain("pendiente-0");

    // Y tools/list se lo dice al cliente antes de que llame, en las cinco que ve.
    const { tools } = await cliente.listTools();
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.inputSchema["additionalProperties"], tool.name).toBe(false);
    }

    await cliente.close();
  });

  it("solo read, las cinco de lectura", async () => {
    const cliente = await conectar(await emitirClave(db, ["READ"]));

    expect(await nombres(cliente)).toEqual(LECTURA);

    await cliente.close();
  });

  it("MCP_DESTRUCTIVE_POLICY se lee por peticion: con deny, delete_task no se anuncia", async () => {
    process.env["MCP_DESTRUCTIVE_POLICY"] = "deny";
    const cliente = await conectar(await emitirClave(db, ["READ", "WRITE", "DELETE"]));

    expect(await nombres(cliente)).not.toContain("delete_task");

    await cliente.close();
  });

  it("GET y DELETE con clave: 405 con Allow: POST, porque no hay sesion", async () => {
    const clave = await emitirClave(db, ["READ"]);

    for (const [handler, metodo] of [
      [GET, "GET"],
      [DELETE, "DELETE"],
    ] as const) {
      const respuesta = await handler(mensaje(clave, "", {}, metodo));

      expect(respuesta.status).toBe(405);
      expect(respuesta.headers.get("allow")).toBe("POST");
      expect(respuesta.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });
});

/**
 * LAS ONCE POR EL TRANSPORTE, UNA POR UNA, CON EFECTO.
 *
 * El bloque de arriba mide el CATALOGO de /mcp; esto mide que cada herramienta
 * del catalogo HACE lo que dice cuando entra por aca. Antes solo cuatro corrian
 * por /mcp —create_board, list_tasks, move_task, list_boards— y las otras siete
 * aparecian en el listado y en ningun otro lado: una rotura del transporte que
 * les tocara a ellas dejaba `verify` en verde. Cada herramienta llega al nucleo
 * con sus propios argumentos, asi que probar cuatro y suponer siete es suponer
 * justamente lo que puede fallar.
 *
 * Son los mismos once casos que `http-port.test.ts` corre por HttpPort, y NO lo
 * duplican: aquella suite monta el registro sobre un transporte en memoria y lo
 * que pone a prueba es el PUERTO; esta usa `CorePort` y lo que pone a prueba es
 * el TRANSPORTE —el cliente de la SDK, `conAuthMcp`, `atenderMcp`, el cuerpo
 * leido por `leerCuerpo` y el `WebStandardStreamableHTTPServerTransport`—.
 *
 * EL EFECTO SE LEE POR SQL, con la conexion `pg` de la suite, y no de lo que
 * contesto la herramienta: preguntarle al que acaba de escribir si escribio es
 * preguntarle al acusado. Las LECTURAS no tienen efecto que leer, asi que lo que
 * se compara es su salida contra lo que la base dice, no contra un valor escrito
 * aca.
 *
 * `delete_task` va con una clave que TIENE `delete` y la politica en `confirm`,
 * puesta explicita y no heredada del entorno: es la de la 8.3.2 por defecto y
 * la unica que recorre los dos pasos —la pregunta, que no toca nada, y el
 * borrado confirmado—. `allow` saltearia el primero y `deny` no borraria.
 */
describe("/mcp: las once herramientas de la 8.2, con efecto, por el transporte", () => {
  let cliente: McpClient;

  beforeEach(async () => {
    const clave = await emitirClave(db, ["READ", "WRITE", "DELETE"], { label: "las once por /mcp" });
    cliente = await conectar(clave);
  });

  afterEach(async () => {
    await cliente.close();
  });

  function llamar(name: string, args: Record<string, unknown>): Promise<Resultado> {
    return llamarCon(cliente, name, args);
  }

  /** La tarea tal como quedo en la base, con la key de su columna. */
  async function tareaEnLaBase(id: string): Promise<Record<string, unknown> | undefined> {
    const filas = await db.query(
      `SELECT t.title, t.description, t.priority::text AS priority,
              t.due_date::text AS due_date, t.position, c.key AS column_key
         FROM task t JOIN board_column c ON c.id = t.column_id
        WHERE t.id = $1`,
      [id],
    );
    return filas.rows[0];
  }

  it("list_boards lista los tableros que hay en la base", async () => {
    await sembrarTablero(port(), { name: "Uno" });
    await sembrarTablero(port(), { name: "Dos" });

    const salida = ok(await llamar("list_boards", {}));

    const enLaBase = await db.query<{ id: string }>("SELECT id FROM board ORDER BY id");
    expect((salida["boards"] as unknown[]).map(idDe).sort()).toEqual(
      enLaBase.rows.map((fila) => fila.id),
    );
  });

  it("get_board trae las columnas del tablero y el recuento de cada una", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "TODO", prefijo: "t", cantidad: 2 });

    const salida = ok(await llamar("get_board", { board: "QA" }));

    const enLaBase = await db.query<{ key: string; task_count: number }>(
      `SELECT c.key, count(t.id)::int AS task_count
         FROM board_column c LEFT JOIN task t ON t.column_id = c.id
        WHERE c.board_id = $1 GROUP BY c.id ORDER BY c.position`,
      [tablero.id],
    );
    const columnas = salida["columns"] as Array<{ key: string; task_count: number }>;
    expect(columnas.map(({ key, task_count }) => ({ key, task_count }))).toEqual(enLaBase.rows);
  });

  it("create_board escribe el tablero con sus cuatro columnas", async () => {
    const salida = ok(await llamar("create_board", { name: "Nuevo" }));

    const tableros = await db.query<{ id: string }>("SELECT id FROM board WHERE name = 'Nuevo'");
    expect(tableros.rows.map((fila) => fila.id)).toEqual([idDe(salida["board"])]);
    const columnas = await db.query<{ key: string }>(
      "SELECT key FROM board_column WHERE board_id = $1 ORDER BY position",
      [idDe(salida["board"])],
    );
    expect(columnas.rows.map((fila) => fila.key)).toEqual(COLUMNAS_POR_DEFECTO);
  });

  it("create_column escribe la columna al final del tablero", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });

    ok(await llamar("create_column", { board: "QA", name: "En revision", key: "REVIEW" }));

    const columnas = await db.query<{ key: string; name: string }>(
      "SELECT key, name FROM board_column WHERE board_id = $1 ORDER BY position",
      [tablero.id],
    );
    expect(columnas.rows.at(-1)).toEqual({ key: "REVIEW", name: "En revision" });
    expect(columnas.rows).toHaveLength(COLUMNAS_POR_DEFECTO.length + 1);
  });

  it("list_tasks lista las tareas de una columna, en el orden de la base", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "TODO", prefijo: "todo", cantidad: 2 });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "DONE", prefijo: "done", cantidad: 1 });

    const salida = ok(await llamar("list_tasks", { board: "QA", column: "TODO" }));

    const enLaBase = await db.query<{ id: string }>(
      `SELECT t.id FROM task t JOIN board_column c ON c.id = t.column_id
        WHERE c.board_id = $1 AND c.key = 'TODO' ORDER BY t.position`,
      [tablero.id],
    );
    expect((salida["tasks"] as unknown[]).map(idDe)).toEqual(enLaBase.rows.map((fila) => fila.id));
  });

  it("search_tasks encuentra por texto en todos los tableros", async () => {
    const taskman = port();
    const uno = await sembrarTablero(taskman, { name: "Uno" });
    const dos = await sembrarTablero(taskman, { name: "Dos" });
    await taskman.createTask({ boardId: uno.id, columnKey: "TODO", title: "Revisar contrato" }, ctx());
    await taskman.createTask({ boardId: dos.id, columnKey: "TODO", title: "Firmar contrato" }, ctx());
    await taskman.createTask({ boardId: dos.id, columnKey: "TODO", title: "Otra cosa" }, ctx());

    const salida = ok(await llamar("search_tasks", { text: "contrato" }));

    const enLaBase = await db.query<{ id: string }>(
      "SELECT id FROM task WHERE title LIKE '%contrato' ORDER BY id",
    );
    expect((salida["tasks"] as unknown[]).map(idDe).sort()).toEqual(
      enLaBase.rows.map((fila) => fila.id),
    );
  });

  it("get_task devuelve la tarea como esta en la base", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    const tarea = await port().createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "Revisar HU-25", description: "el detalle" },
      ctx(),
    );

    const salida = ok(await llamar("get_task", { task: tarea.id }));

    const enLaBase = await tareaEnLaBase(tarea.id);
    const devuelta = salida["task"] as Record<string, unknown>;
    expect({
      title: devuelta["title"],
      description: devuelta["description"],
      column_key: devuelta["column_key"],
    }).toEqual({
      title: enLaBase?.["title"],
      description: enLaBase?.["description"],
      column_key: enLaBase?.["column_key"],
    });
  });

  it("create_task escribe la tarea al final de la columna, con prioridad y fecha", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "TODO", prefijo: "primera", cantidad: 1 });

    const salida = ok(
      await llamar("create_task", {
        board: "QA",
        column: "TODO",
        title: "segunda",
        priority: "HIGH",
        due_date: "2026-09-11",
      }),
    );

    expect(await tareaEnLaBase(idDe(salida["task"]))).toMatchObject({
      title: "segunda",
      priority: "HIGH",
      due_date: "2026-09-11",
      position: 1,
      column_key: "TODO",
    });
  });

  it("update_task escribe los campos, y un null borra", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    const tarea = await port().createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "vieja", description: "con descripcion" },
      ctx(),
    );

    ok(await llamar("update_task", { task: tarea.id, title: "nueva", description: null }));

    expect(await tareaEnLaBase(tarea.id)).toMatchObject({ title: "nueva", description: null });
  });

  it("move_task cambia la tarea de columna y deja denso el orden", async () => {
    const tablero = await sembrarTablero(port(), { name: "QA" });
    await sembrarTareas(port(), { boardId: tablero.id, columnKey: "TODO", prefijo: "queda", cantidad: 1 });
    const tarea = await port().createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "viajera" },
      ctx(),
    );

    ok(await llamar("move_task", { task: tarea.id, to_column: "DONE" }));

    expect(await tareaEnLaBase(tarea.id)).toMatchObject({ column_key: "DONE", position: 0 });
    const enTodo = await db.query<{ position: number }>(
      `SELECT t.position FROM task t JOIN board_column c ON c.id = t.column_id
        WHERE c.board_id = $1 AND c.key = 'TODO'`,
      [tablero.id],
    );
    expect(enTodo.rows).toEqual([{ position: 0 }]);
  });

  it("delete_task, con confirm: la pregunta no toca la base y el borrado confirmado la borra", async () => {
    process.env["MCP_DESTRUCTIVE_POLICY"] = "confirm";
    const tablero = await sembrarTablero(port(), { name: "QA" });
    const tarea = await port().createTask(
      { boardId: tablero.id, columnKey: "TODO", title: "condenada" },
      ctx(),
    );

    // 8.3.2: el primer paso es una pregunta, no un fallo, y no toca nada.
    expect(error(await llamar("delete_task", { task: tarea.id }))["code"]).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(await tareaEnLaBase(tarea.id)).toMatchObject({ title: "condenada" });

    ok(await llamar("delete_task", { task: tarea.id, confirm: true }));

    expect(await tareaEnLaBase(tarea.id)).toBeUndefined();
  });
});

describe("/mcp: actor y correlacion (7.4, 6.1, 11.1)", () => {
  it("una escritura queda AGENT, con la etiqueta, el prefijo y el request_id de la respuesta y del log", async () => {
    // SIN `agente: true`, o sea rotulada API en `api_key.actor_type`, y aun asi
    // todo lo de abajo dice AGENT. Desde el paso 12 eso no es un detalle del
    // fixture: es la asimetria entre los dos bordes. /api deriva el actor de la
    // CLAVE porque no puede ver por donde entro una peticion; /mcp lo fija por
    // construccion porque si lo ve. Una clave "de cliente REST" usada contra
    // /mcp sigue siendo una llamada MCP.
    const clave = await emitirClave(db, ["READ", "WRITE"], { label: "claude remoto" });

    const respuesta = await POST(
      mensaje(clave, "tools/call", { name: "create_board", arguments: { name: "Auditado" } }),
    );

    expect(respuesta.status).toBe(200);
    const requestId = respuesta.headers.get("x-request-id");
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/);

    const cuerpo = (await respuesta.json()) as { result: { isError?: boolean } };
    expect(cuerpo.result.isError).toBeFalsy();

    const auditoria = await db.query<{
      actor_type: string;
      actor_name: string;
      client_id: string | null;
      request_id: string;
    }>(
      `SELECT actor_type::text AS actor_type, actor_name, client_id, request_id
         FROM audit_log WHERE entity_type = 'board'`,
    );
    expect(auditoria.rows).toEqual([
      {
        actor_type: "AGENT",
        actor_name: "claude remoto",
        client_id: prefijoDe(clave),
        request_id: requestId,
      },
    ]);

    // La linea por peticion y la de la herramienta llevan el MISMO id.
    expect(lineasDePeticion()).toEqual([
      expect.objectContaining({
        request_id: requestId,
        route: "/mcp",
        status: 200,
        client_id: prefijoDe(clave),
        actor_type: "AGENT",
      }),
    ]);
    expect(lineas.find((linea) => linea.campos["evt"] === "mcp.tool")?.campos).toMatchObject({
      tool: "create_board",
      requestId,
      actorType: "AGENT",
      actorName: "claude remoto",
      outcome: "ok",
    });
  });
});

// --- Endurecimiento del borde (7.3, 6.4, Streamable HTTP) --------------------

/** Un POST crudo a /mcp con cualquier cuerpo JSON y cabeceras extra. */
function post(
  clave: string | undefined,
  cuerpo: unknown,
  cabeceras: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...cabeceras,
  });
  if (clave !== undefined) {
    headers.set("authorization", `Bearer ${clave}`);
  }
  return POST(new Request(URL_MCP, { method: "POST", headers, body: JSON.stringify(cuerpo) }));
}

function llamada(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

const LISTAR = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const KB = 1024;

/**
 * Un cuerpo de `totalKb` KB que anota cuanto le pidieron y si lo cancelaron. Es
 * la misma medicion que `cuerpo.test.ts` hace para /api: el stream no produce
 * nada hasta que alguien lee, asi que `entregados()` es lo que CRUZO.
 */
function cuerpoQueCuenta(totalKb: number, trozoKb = 64) {
  const trozo = new Uint8Array(trozoKb * KB).fill(0x20);
  let entregados = 0;
  let restantes = Math.ceil(totalKb / trozoKb);
  let cancelado = false;

  const stream = new ReadableStream<Uint8Array>({
    pull(controlador) {
      if (restantes === 0) {
        controlador.close();
        return;
      }
      restantes -= 1;
      entregados += trozo.byteLength;
      controlador.enqueue(trozo);
    },
    cancel() {
      cancelado = true;
    },
  });

  return { stream, entregados: () => entregados, cancelado: () => cancelado };
}

describe("/mcp: tope de 256 KB por cuerpo (7.3)", () => {
  it("MIDE que no se lee entero: de 50 MB cruzan del orden del tope, se cancela y es 413", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE"]);
    const medido = cuerpoQueCuenta(50 * KB);

    const respuesta = await POST(
      new Request(URL_MCP, {
        method: "POST",
        headers: {
          authorization: `Bearer ${clave}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: medido.stream,
        // Node lo exige para un cuerpo de stream.
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(respuesta.status).toBe(413);
    expect(((await respuesta.json()) as { error: { code: string } }).error.code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
    expect(respuesta.headers.get("x-request-id")).toMatch(/^req_/);

    // Lo corto `leerCuerpo`: el transporte del SDK no llego a leer nada.
    expect(medido.cancelado()).toBe(true);
    expect(medido.entregados()).toBeLessThanOrEqual(LIMITE_CUERPO_BYTES * 2);
    expect(medido.entregados()).toBeLessThan(50 * KB * KB * 0.02);
  });

  it("un cuerpo chico le llega al transporte ya leido: tools/list responde", async () => {
    const clave = await emitirClave(db, ["READ"]);

    const respuesta = await post(clave, LISTAR);

    expect(respuesta.status).toBe(200);
    expect(((await respuesta.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(5);
  });
});

describe("/mcp: limite de peticiones (7.3) y que cupo cobra cada mensaje (D5)", () => {
  beforeEach(() => {
    reiniciarLimiteDePeticiones();
    process.env["RATE_LIMIT_ENABLED"] = "true";
  });

  afterEach(() => {
    process.env["RATE_LIMIT_ENABLED"] = "false";
    reiniciarLimiteDePeticiones();
  });

  it("tools/list cobra LECTURA: pasan 120 y la 121 recibe 429 con Retry-After", async () => {
    const clave = await emitirClave(db, ["READ"]);

    for (let i = 0; i < LIMITE_POR_CUBO.lectura; i += 1) {
      expect((await post(clave, LISTAR)).status, `peticion ${i + 1}`).toBe(200);
    }

    const rechazada = await post(clave, LISTAR);
    expect(rechazada.status).toBe(429);
    expect(rechazada.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    expect(((await rechazada.json()) as { error: { details: unknown } }).error.details).toMatchObject({
      bucket: "read",
      limit: 120,
    });
  });

  it("un tools/call de escritura cobra ESCRITURA: pasan 30, la 31 es 429 y no escribe; las lecturas siguen", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE"]);

    for (let i = 0; i < LIMITE_POR_CUBO.escritura; i += 1) {
      const respuesta = await post(clave, llamada(i, "create_board", { name: `T${i}` }));
      expect(respuesta.status, `escritura ${i + 1}`).toBe(200);
    }

    const rechazada = await post(clave, llamada(99, "create_board", { name: "La 31" }));
    expect(rechazada.status).toBe(429);
    expect(((await rechazada.json()) as { error: { details: unknown } }).error.details).toMatchObject({
      bucket: "write",
      limit: 30,
    });
    expect((await db.query("SELECT 1 FROM board")).rowCount).toBe(30);

    // list_boards es de lectura: cobra el OTRO cupo, que sigue libre.
    expect((await post(clave, llamada(100, "list_boards", {}))).status).toBe(200);
  });

  it("una herramienta que la clave NO tiene igual cobra su cupo, como el 429 antes del 403 de REST", async () => {
    const clave = await emitirClave(db, ["READ"]);

    for (let i = 0; i < LIMITE_POR_CUBO.escritura; i += 1) {
      expect((await post(clave, llamada(i, "delete_task", { task: "x", confirm: true }))).status).toBe(200);
    }

    expect((await post(clave, llamada(99, "delete_task", { task: "x", confirm: true }))).status).toBe(429);
  });

  it("un lote cobra un lugar POR MENSAJE: 31 create_board en un solo POST no pasan", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE"]);
    const lote = Array.from({ length: 31 }, (_, i) => llamada(i, "create_board", { name: `L${i}` }));

    expect((await post(clave, lote)).status).toBe(429);
    expect((await db.query("SELECT 1 FROM board")).rowCount).toBe(0);
  });

  it("ejemplo 5 del Anexo A: list_tasks y 30 move_task entran justo; el move 31 recibe 429", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE"], { label: "agente epx" });
    const taskman = port();
    const tablero = await sembrarTablero(taskman, { name: "EPX-25" });
    await sembrarTareas(taskman, { boardId: tablero.id, columnKey: "BACKLOG", prefijo: "HU", cantidad: 31 });

    const cliente = await conectar(clave);

    const listado = await cliente.callTool({
      name: "list_tasks",
      arguments: { board: "EPX-25", column: "BACKLOG" },
    });
    expect(listado.isError).toBeFalsy();

    for (let i = 0; i < 30; i += 1) {
      const movida = await cliente.callTool({
        name: "move_task",
        arguments: { task: `HU-${i}`, board: "EPX-25", to_column: "TODO" },
      });
      expect(movida.isError, `move_task ${i + 1}`).toBeFalsy();
    }

    // El cliente de la SDK lo recibe como error HTTP, no como resultado de herramienta.
    await expect(
      cliente.callTool({
        name: "move_task",
        arguments: { task: "HU-30", board: "EPX-25", to_column: "TODO" },
      }),
    ).rejects.toMatchObject({ code: 429 });

    const enTodo = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM task t JOIN board_column c ON c.id = t.column_id WHERE c.key = $1",
      ["TODO"],
    );
    expect(enTodo.rows[0]).toEqual({ n: 30 });

    await cliente.close();
  });
});

describe("/mcp: Origin (Streamable HTTP, contra DNS rebinding)", () => {
  it("con un Origin presente, 403 FORBIDDEN_ORIGIN aunque la clave sea valida, antes de autenticar", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE", "DELETE"]);
    const origenes = ["https://evil.example", "http://localhost:3000", "null"];

    for (const origen of origenes) {
      const respuesta = await post(clave, LISTAR, { origin: origen });

      expect(respuesta.status, origen).toBe(403);
      const cuerpo = (await respuesta.json()) as {
        error: { code: string; details: unknown; request_id: string };
      };
      expect(cuerpo.error.code).toBe("FORBIDDEN_ORIGIN");
      expect(cuerpo.error.details).toEqual({ origin: origen });
      expect(cuerpo.error.request_id).toBe(respuesta.headers.get("x-request-id"));
    }

    // Antes de la clave: ninguna linea tiene client_id.
    expect(lineasDePeticion().map((linea) => [linea["status"], linea["client_id"]])).toEqual(
      origenes.map(() => [403, null]),
    );
  });

  it("SIN Origin —lo que manda un cliente que no es navegador— pasa", async () => {
    const respuesta = await post(await emitirClave(db, ["READ"]), LISTAR);

    expect(respuesta.status).toBe(200);
  });
});

describe("/mcp: el INTERNAL_ERROR de la 6.4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no expone la causa, trae el request_id de la respuesta, y la traza queda en el log", async () => {
    const clave = await emitirClave(db, ["READ"]);
    vi.spyOn(CorePort.prototype, "listBoards").mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "board_secreto_idx"'),
    );

    const respuesta = await post(clave, llamada(1, "list_boards", {}));

    expect(respuesta.status).toBe(200);
    const requestId = respuesta.headers.get("x-request-id");
    const cuerpo = (await respuesta.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const texto = cuerpo.result.content[0]?.text ?? "";

    expect(cuerpo.result.isError).toBe(true);
    expect(texto).toContain("INTERNAL_ERROR");
    expect(texto).not.toContain("board_secreto_idx");
    expect(texto).not.toContain("reason");
    expect(texto).toContain(`"request_id": "${requestId}"`);

    const herramienta = lineas.find((linea) => linea.campos["evt"] === "mcp.tool")?.campos;
    expect(herramienta).toMatchObject({ requestId, outcome: "error" });
    expect((herramienta?.["err"] as { message: string }).message).toContain("board_secreto_idx");
  });
});
