import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectDb, ctx, emitirClave, port, truncateAll } from "./helpers";
import { levantarServidorRest, type ServidorRest } from "./servidor-rest";

/**
 * `MCP_PORT_MODE=http` (8.1) EN EL PROCESO DE VERDAD: el binario empaquetado de
 * `apps/mcp-stdio`, arrancado con su bloque `env` como lo arranca Claude Code
 * (8.6), hablando por stdio con un cliente y por HTTP con un servidor REST real.
 *
 * POR QUE ACA Y NO EN `apps/mcp-stdio`. Lo que falta en el otro lado es el
 * servidor: esa app no puede importar los Route Handlers de `apps/web`, que son
 * la otra punta del cable. Es el mismo motivo por el que la suite de `HttpPort`
 * vive aca, y se alcanza igual —`@taskman/mcp-stdio` es devDependency de este
 * paquete— sin cambiar el grafo de dependencias de la 3.3.
 *
 * QUE AGREGA sobre `http-port.test.ts`, que ya prueba las once herramientas y el
 * descubrimiento de scopes contra el mismo servidor: el CABLEADO. Que el modo
 * elija el puerto correcto, que la URL y la clave lleguen del entorno al
 * `HttpPort`, que los scopes descubiertos sean los que se usan para montar y que
 * una variable ausente impida el arranque en vez de fallar en la primera
 * llamada (11.2). Nada de eso pasa por `HttpPort` ni por el registro: pasa por
 * `src/index.ts`, que es codigo que ninguna otra prueba ejecuta.
 */

const ENTRADA = createRequire(import.meta.url).resolve("@taskman/mcp-stdio");

let db: Client;
let servidor: ServidorRest;

interface Sesion {
  readonly herramientas: string[];
  readonly llamada: string;
}

/** Lo que un proceso que no llego a arrancar deja atras. */
interface Arranque {
  readonly code: number | null;
  readonly stderr: string;
}

function entornoBase(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MCP_PORT_MODE: "http",
    TASKMAN_API_URL: servidor.url,
    // En modo http no se usa, y estas pruebas la sacan a proposito: el `.env`
    // del repo la define para todo lo demas, asi que heredarla taparia el caso
    // que importa —que este modo no la necesita—.
    DATABASE_URL: undefined,
  };
}

/**
 * Arranca el servidor MCP, hace `initialize`, `tools/list` y un `tools/call`, y
 * devuelve lo que contesto. Rechaza si el proceso muere antes de contestar, con
 * su stderr, que es donde va el motivo.
 */
async function sesion(env: NodeJS.ProcessEnv): Promise<Sesion> {
  expect(existsSync(ENTRADA), `No existe ${ENTRADA}. Corre pnpm run build antes de la suite.`).toBe(
    true,
  );

  return new Promise<Sesion>((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [ENTRADA], { env, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const reloj = setTimeout(() => {
      hijo.kill();
      rechazar(new Error(`El servidor no respondio a tiempo.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);

    const terminar = (): void => {
      clearTimeout(reloj);
      hijo.kill();

      const mensajes = stdout
        .split("\n")
        .filter((linea) => linea.trim() !== "")
        .map((linea) => JSON.parse(linea) as { id?: number; result?: Record<string, unknown> });

      const listado = mensajes.find((mensaje) => mensaje.id === 2)?.result;
      const llamada = mensajes.find((mensaje) => mensaje.id === 3)?.result;

      resolver({
        herramientas: ((listado?.["tools"] ?? []) as Array<{ name: string }>).map((h) => h.name),
        llamada: JSON.stringify(llamada),
      });
    };

    hijo.stdout.on("data", (trozo: Buffer) => {
      stdout += trozo.toString();
      if (stdout.includes('"id":3')) {
        terminar();
      }
    });
    hijo.stderr.on("data", (trozo: Buffer) => {
      stderr += trozo.toString();
    });
    hijo.on("error", (error) => {
      clearTimeout(reloj);
      rechazar(error);
    });
    hijo.on("close", () => {
      clearTimeout(reloj);
      rechazar(new Error(`El servidor termino sin contestar.\nstderr:\n${stderr}`));
    });

    const enviar = (mensaje: unknown): void => {
      hijo.stdin.write(`${JSON.stringify(mensaje)}\n`);
    };

    enviar({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "prueba-modo-http", version: "0.0.0" },
      },
    });
    enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
    enviar({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    enviar({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_boards", arguments: {} },
    });
  });
}

/** Arranca el servidor y espera a que MUERA. Para los casos de la 11.2. */
async function arranque(env: NodeJS.ProcessEnv): Promise<Arranque> {
  return new Promise<Arranque>((resolver) => {
    const hijo = spawn(process.execPath, [ENTRADA], { env, stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    hijo.stderr.on("data", (trozo: Buffer) => {
      stderr += trozo.toString();
    });
    hijo.on("close", (code) => resolver({ code, stderr }));
  });
}

beforeAll(async () => {
  db = await connectDb();
  servidor = await levantarServidorRest();
});

afterAll(async () => {
  await servidor.cerrar();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe("apps/mcp-stdio en MCP_PORT_MODE=http (8.1)", () => {
  it("arranca sin DATABASE_URL y las herramientas funcionan contra el servidor", async () => {
    const clave = await emitirClave(db, ["READ", "WRITE", "DELETE"], { label: "stdio http" });
    await port().createBoard({ name: "Tablero remoto" }, ctx());

    const { herramientas, llamada } = await sesion({ ...entornoBase(), TASKMAN_API_KEY: clave });

    // Las once de la 8.2, porque la clave tiene los tres scopes.
    expect(herramientas).toHaveLength(11);
    expect(herramientas).toContain("delete_task");

    // Y la llamada viajo hasta la base por HTTP: el tablero lo creo esta prueba
    // en el proceso de vitest, y el que lo leyo es otro proceso que no tiene
    // DATABASE_URL.
    expect(llamada).toContain("Tablero remoto");
  });

  it("con una clave sin delete, el catalogo llega con diez herramientas", async () => {
    // El mismo DEBE de la 8.1 que mide `http-port.test.ts`, pero de punta a
    // punta: por aca pasa que los scopes descubiertos sean los que se montan.
    const clave = await emitirClave(db, ["READ", "WRITE"], { label: "stdio http sin borrado" });

    const { herramientas } = await sesion({ ...entornoBase(), TASKMAN_API_KEY: clave });

    expect(herramientas).toHaveLength(10);
    expect(herramientas).not.toContain("delete_task");
  });

  it("sin TASKMAN_API_URL no arranca, con el mensaje que la nombra (11.2)", async () => {
    const { code, stderr } = await arranque({
      ...entornoBase(),
      TASKMAN_API_URL: undefined,
      TASKMAN_API_KEY: "tmk_live_loquesea",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("TASKMAN_API_URL");
    expect(stderr).toContain(".mcp.json");
  });

  it("sin TASKMAN_API_KEY no arranca, con el mensaje que la nombra (11.2)", async () => {
    const { code, stderr } = await arranque({ ...entornoBase(), TASKMAN_API_KEY: undefined });

    expect(code).toBe(1);
    expect(stderr).toContain("TASKMAN_API_KEY");
  });

  it("con una clave que el servidor rechaza tampoco arranca", async () => {
    // El 401 lo ve el servidor y no el esquema, pero es lo mismo: la variable
    // tiene un valor invalido. Arrancar daria once herramientas que fallan las
    // once.
    const { code, stderr } = await arranque({
      ...entornoBase(),
      TASKMAN_API_KEY: "tmk_live_noexiste",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("TASKMAN_API_KEY");
    expect(stderr).toContain("401");
  });

  it("una variable comun invalida tambien impide el arranque en este modo", async () => {
    const { code, stderr } = await arranque({
      ...entornoBase(),
      TASKMAN_API_KEY: "tmk_live_loquesea",
      LOG_LEVEL: "verbose",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("LOG_LEVEL");
  });
});
