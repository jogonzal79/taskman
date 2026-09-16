import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { prefijoDe, type CamposDeLog, type Logger } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DELETE, GET, POST } from "../app/mcp/route";
import { fijarLogger } from "../lib/log";
import { connectDb, emitirClave, truncateAll } from "./helpers";

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

describe("/mcp: actor y correlacion (7.4, 6.1, 11.1)", () => {
  it("una escritura queda AGENT, con la etiqueta, el prefijo y el request_id de la respuesta y del log", async () => {
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
