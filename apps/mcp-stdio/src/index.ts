import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { crearCorePort } from "@taskman/core";

import { validarEntorno } from "./config";
import { crearLogger } from "./log";
import { crearServidorMcp } from "./server";

/**
 * Entrypoint del transporte stdio (8.1): Claude Code en la misma maquina que la
 * base de datos.
 *
 * Nada puede escribir en stdout salvo los mensajes del protocolo: stdout ES el
 * canal MCP. Todo diagnostico va a stderr.
 */

function fallar(mensaje: string): never {
  process.stderr.write(`[taskman-mcp] ${mensaje}\n`);
  process.exit(1);
}

/**
 * TODA la configuracion de la 11.2, de una vez y antes de tocar la base.
 *
 * Eran cuatro bloques sueltos —MCP_PORT_MODE contra un Set, DATABASE_URL no
 * vacia, y la politica destructiva y el nivel de log con un try/catch cada uno—
 * y la primera que fallaba tapaba a las demas: arrancar sin `.mcp.json` obligaba
 * a un reinicio por variable. El esquema las junta y el mensaje las lista todas.
 */
function configuracion(): ReturnType<typeof validarEntorno> {
  try {
    return validarEntorno(process.env);
  } catch (error: unknown) {
    return fallar(error instanceof Error ? error.message : String(error));
  }
}

const { MCP_PORT_MODE: modo, LOG_LEVEL: nivelLog, MCP_DESTRUCTIVE_POLICY: politicaDestructiva } =
  configuracion();

// Escribe a fd 2 con destino sincrono: ver el porque en ./log.ts. Una linea de
// log en stdout no es un log mal ubicado, es un mensaje corrupto del protocolo.
const logger = crearLogger(nivelLog);

const servidor = crearServidorMcp(crearCorePort(), { politicaDestructiva, logger });
await servidor.connect(new StdioServerTransport());

logger.info(
  {
    evt: "mcp.ready",
    mode: modo,
    transport: "stdio",
    destructivePolicy: politicaDestructiva,
    logLevel: nivelLog,
  },
  "servidor listo",
);
