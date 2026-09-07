import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  crearCorePort,
  leerPoliticaDestructiva,
  type PoliticaDestructiva,
} from "@taskman/core";

import { crearLogger, leerNivelLog, type NivelLog } from "./log.js";
import { crearServidorMcp } from "./server.js";

/**
 * Entrypoint del transporte stdio (8.1): Claude Code en la misma maquina que la
 * base de datos.
 *
 * Nada puede escribir en stdout salvo los mensajes del protocolo: stdout ES el
 * canal MCP. Todo diagnostico va a stderr.
 */

const MODOS = new Set(["core"]);

function fallar(mensaje: string): never {
  process.stderr.write(`[taskman-mcp] ${mensaje}\n`);
  process.exit(1);
}

const modo = process.env["MCP_PORT_MODE"] ?? "core";
if (!MODOS.has(modo)) {
  // `http` esta en la 8.1 pero HttpPort no existe todavia: no hay API REST
  // contra la cual probarlo. Arrancar igual daria un servidor que lista tres
  // herramientas y falla en la primera llamada, que es peor que no arrancar.
  fallar(
    `MCP_PORT_MODE="${modo}" no esta implementado. En F2.1 el unico modo es "core" (servicios en proceso).`,
  );
}

if ((process.env["DATABASE_URL"] ?? "").trim() === "") {
  fallar("Falta DATABASE_URL. Definila en el bloque env del .mcp.json o en el entorno.");
}

/**
 * MCP_DESTRUCTIVE_POLICY (11.2). Se valida ANTES de tocar la base: una variable
 * invalida tiene que impedir el arranque con un mensaje explicito y no producir
 * un fallo posterior. Arrancar con el valor por defecto ante un valor mal
 * escrito seria peor que no arrancar: quien puso "denyy" cree tener el borrado
 * apagado y lo tendria encendido, solo que preguntando primero.
 */
function leerPolitica(): PoliticaDestructiva {
  try {
    return leerPoliticaDestructiva(process.env["MCP_DESTRUCTIVE_POLICY"]);
  } catch (error: unknown) {
    return fallar(error instanceof Error ? error.message : String(error));
  }
}

const politicaDestructiva = leerPolitica();

/**
 * LOG_LEVEL (11.2), con el mismo trato que la politica destructiva: se valida
 * antes de tocar la base y un valor invalido impide el arranque.
 */
function leerNivel(): NivelLog {
  try {
    return leerNivelLog(process.env["LOG_LEVEL"]);
  } catch (error: unknown) {
    return fallar(error instanceof Error ? error.message : String(error));
  }
}

const nivelLog = leerNivel();
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
