import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { crearLogger, leerNivelLog, NIVEL_LOG_POR_DEFECTO, NIVELES_LOG } from "../src/log";

/**
 * El log de la 11.1 en el proceso real, por donde de verdad importa: que NO
 * salga por stdout.
 *
 * En stdio, fd 1 es el canal del protocolo. El destino por defecto de pino es
 * justamente fd 1, asi que "olvidarse" de configurarlo no deja el log en un
 * lugar incomodo: le entrega al cliente MCP lineas que no son JSON-RPC y le
 * rompe la sesion. Por eso esta prueba levanta el binario empaquetado y le
 * habla el protocolo a mano, en vez de usar el transporte de la SDK: lo que hay
 * que mirar es el contenido crudo de cada fd, y un transporte lo consume.
 */

const ENTRADA = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface Sesion {
  stdout: string;
  stderr: string;
}

/**
 * Arranca el servidor, hace un `initialize` y una llamada a `list_boards`, y
 * devuelve lo que escribio en cada fd.
 */
async function sesionStdio(env: Record<string, string> = {}): Promise<Sesion> {
  expect(existsSync(ENTRADA), `No existe ${ENTRADA}. Corre pnpm run build antes de la suite.`).toBe(
    true,
  );

  return new Promise<Sesion>((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [ENTRADA], {
      env: { ...process.env, MCP_PORT_MODE: "core", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let terminado = false;

    const terminar = (): void => {
      if (terminado) {
        return;
      }
      terminado = true;
      hijo.kill();
      resolver({ stdout, stderr });
    };

    const reloj = setTimeout(() => {
      terminado = true;
      hijo.kill();
      rechazar(new Error(`El servidor no respondio a tiempo.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20_000);

    hijo.stdout.on("data", (trozo: Buffer) => {
      stdout += trozo.toString();
      // La respuesta de la llamada es lo ultimo que se espera; con ella llegada,
      // todo lo que el servidor iba a escribir en los dos fd ya esta escrito.
      if (stdout.includes('"id":2')) {
        clearTimeout(reloj);
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
      terminar();
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
        clientInfo: { name: "prueba-log", version: "0.0.0" },
      },
    });
    enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
    enviar({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_boards", arguments: {} },
    });
  });
}

function lineas(texto: string): string[] {
  return texto.split("\n").filter((linea) => linea.trim() !== "");
}

describe("LOG_LEVEL", () => {
  it("acepta los cuatro niveles de la 11.2", () => {
    for (const nivel of NIVELES_LOG) {
      expect(leerNivelLog(nivel)).toBe(nivel);
    }
  });

  it("ausente o vacia es info", () => {
    expect(NIVEL_LOG_POR_DEFECTO).toBe("info");
    expect(leerNivelLog(undefined)).toBe("info");
    expect(leerNivelLog("")).toBe("info");
    expect(leerNivelLog("   ")).toBe("info");
  });

  it("normaliza espacios y mayusculas", () => {
    expect(leerNivelLog(" DEBUG ")).toBe("debug");
  });

  it("un valor invalido lanza con el valor recibido y la lista de posibles", () => {
    // Mismo criterio que MCP_DESTRUCTIVE_POLICY: caer al valor por defecto le
    // daria menos lineas de las que cree tener justo a quien esta diagnosticando.
    expect(() => leerNivelLog("verbose")).toThrow(/verbose/);
    expect(() => leerNivelLog("verbose")).toThrow(/debug, info, warn, error/);
    expect(() => leerNivelLog("trace")).toThrow();
  });

  it("crearLogger devuelve los cuatro metodos de la interfaz del nucleo", () => {
    const logger = crearLogger("error");
    for (const metodo of NIVELES_LOG) {
      expect(typeof logger[metodo]).toBe("function");
    }
  });
});

describe("el log no contamina el canal del protocolo", () => {
  it("stdout lleva SOLO JSON-RPC y el log entero sale por stderr", async () => {
    const { stdout, stderr } = await sesionStdio({ LOG_LEVEL: "debug" });

    // 1. Cada linea de stdout es un mensaje del protocolo. Si el destino de
    //    pino fuera el de por defecto (fd 1), aca aparecerian las lineas de log
    //    y esta comprobacion es la que las encuentra.
    const salida = lineas(stdout);
    expect(salida.length).toBeGreaterThan(0);
    for (const linea of salida) {
      const mensaje: unknown = JSON.parse(linea);
      expect((mensaje as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }

    // 2. Y el log esta, entero, del otro lado.
    const registro = lineas(stderr).map((linea) => JSON.parse(linea) as Record<string, unknown>);
    expect(registro.map((entrada) => entrada["evt"])).toContain("mcp.ready");

    const invocacion = registro.find((entrada) => entrada["evt"] === "mcp.tool");
    expect(invocacion).toMatchObject({
      tool: "list_boards",
      outcome: "ok",
      actorType: "AGENT",
      // El nombre del cliente conectado, leido en la llamada y no al montar.
      actorName: "prueba-log",
    });
    expect(typeof invocacion?.["requestId"]).toBe("string");
    expect(typeof invocacion?.["durationMs"]).toBe("number");
  });

  it("con LOG_LEVEL=error no se registra la invocacion, y stdout sigue limpio", async () => {
    const { stdout, stderr } = await sesionStdio({ LOG_LEVEL: "error" });

    for (const linea of lineas(stdout)) {
      expect((JSON.parse(linea) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    }

    const eventos = lineas(stderr).map(
      (linea) => (JSON.parse(linea) as Record<string, unknown>)["evt"],
    );
    expect(eventos).not.toContain("mcp.tool");
  });

  it("un LOG_LEVEL invalido impide el arranque (11.2)", async () => {
    const salida = await new Promise<{ code: number | null; stderr: string }>((resolver) => {
      const hijo = spawn(process.execPath, [ENTRADA], {
        env: { ...process.env, MCP_PORT_MODE: "core", LOG_LEVEL: "verbose" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      hijo.stderr.on("data", (trozo: Buffer) => {
        stderr += trozo.toString();
      });
      hijo.on("close", (code) => resolver({ code, stderr }));
    });

    expect(salida.code).toBe(1);
    expect(salida.stderr).toContain("LOG_LEVEL");
    expect(salida.stderr).toContain("debug, info, warn, error");
  });
});
