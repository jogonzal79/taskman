import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  crearCorePort,
  crearHerramientas,
  IDENTIDAD_SERVIDOR_MCP,
  INSTRUCCIONES_MCP,
  leerPoliticaDestructiva,
  montarHerramientas,
  type ActorContext,
} from "@taskman/core";

import type { Autenticacion } from "./auth";
import { responder } from "./http";
import { log } from "./log";

/**
 * El servidor MCP por Streamable HTTP de la 8.1, sobre CorePort: los servicios
 * del nucleo en este mismo proceso, sin pasar por /api.
 *
 * SIN SESION (D4). Cada POST arma su `McpServer` y su transporte, los usa para
 * ESE mensaje y los cierra. Dos motivos, los dos medidos en el paso 2 de F4:
 *
 * - Es barato: montar las once cuesta 0,30 ms y un tools/list 0,86 ms, que se
 *   pagan igual con sesion o sin ella.
 * - Los scopes se leen de la clave EN CADA MENSAJE. Con sesion, el catalogo se
 *   arma una vez al inicializar, y una clave revocada o recortada seguiria
 *   ofreciendo lo de antes mientras dure la sesion. Sin sesion, la ventana es la
 *   del cache de claves de la 7.1 (60 s) y ninguna mas.
 *
 * El transporte es `WebStandardStreamableHTTPServerTransport` porque un Route
 * Handler recibe un `Request` y devuelve un `Response`; el otro del SDK pide
 * `IncomingMessage` y `ServerResponse`. `enableJsonResponse` hace que cada POST
 * responda JSON y no un flujo SSE: sin sesion no hay a quien mandarle nada
 * despues, y un cuerpo ya completo es lo que permite cerrar el servidor al
 * volver.
 *
 * La autorizacion NO esta aca (ADR-003): la clave la verifica `ApiKeyService`
 * (en `conAuthMcp`) y que herramientas alcanza lo decide `crearHerramientas`
 * con sus scopes. Esto solo conecta las piezas.
 */

const taskman = crearCorePort();

/**
 * El `ActorContext` de un mensaje de /mcp (7.4).
 *
 * AGENT por construccion, como `contextoDeAgente` del nucleo: todo lo que entra
 * por /mcp es MCP.
 *
 * `actorName` ES LA ETIQUETA DE LA CLAVE, y no el nombre que el cliente declara
 * en el initialize, que es lo que usa stdio. Sin sesion, el servidor que atiende
 * un tools/call es otro que el que vio el initialize, asi que
 * `getClientVersion()` da undefined y todo quedaria como "mcp-desconocido". La
 * etiqueta, en cambio, la conocemos en cada mensaje, y es mejor dato: la eligio
 * quien emitio la clave ("claude-code notebook") y viene autenticada, mientras
 * que el `clientInfo.name` lo escribe el cliente y puede decir cualquier cosa. Es
 * el mismo criterio que `contextoDeApi` para REST.
 *
 * `clientId` es el prefijo publico de la clave (5.1), y `requestId` el de la
 * peticion HTTP: el mismo que sale en X-Request-Id y en la linea de log. Cada
 * POST lleva un mensaje, asi que un request_id por peticion es uno por llamada.
 *
 * No hay que recortar nada, por lo mismo que en `contextoDeApi`: la etiqueta es
 * VARCHAR(80) y el prefijo VARCHAR(24), contra los VARCHAR(120) de `audit_log`.
 */
export function contextoDeMcp(auth: Autenticacion): ActorContext {
  return {
    actorType: "AGENT",
    actorName: auth.clave.label,
    clientId: auth.clave.prefix,
    requestId: auth.requestId,
  };
}

/**
 * Atiende UN mensaje de /mcp con una clave ya verificada.
 *
 * GET y DELETE responden 405. En Streamable HTTP, GET abre un flujo SSE para
 * mensajes que el servidor inicia y DELETE cierra una sesion: sin sesion no hay
 * ni lo uno ni lo otro, y pasarle un GET al transporte abriria un flujo con su
 * latido que nadie va a usar. El cliente de la SDK trata el 405 del GET como "este
 * servidor no tiene flujo" y sigue.
 */
export async function atenderMcp(request: Request, auth: Autenticacion): Promise<Response> {
  if (request.method !== "POST") {
    return responder(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: /mcp no tiene sesion y solo acepta POST." },
        id: null,
      },
      405,
      auth,
      { Allow: "POST" },
    );
  }

  const servidor = new McpServer(IDENTIDAD_SERVIDOR_MCP, { instructions: INSTRUCCIONES_MCP });
  const contexto = contextoDeMcp(auth);

  montarHerramientas(
    servidor,
    crearHerramientas(taskman, {
      // 8.1: "aplicar los mismos scopes". Lo que la clave no alcanza no se monta.
      scopes: auth.clave.scopes,
      // Validada al arrancar por `lib/config.ts`, con esta misma funcion.
      politicaDestructiva: leerPoliticaDestructiva(process.env["MCP_DESTRUCTIVE_POLICY"]),
      contexto: () => contexto,
      logger: log(),
    }),
  );

  const transporte = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  try {
    await servidor.connect(transporte);

    const respuesta = await transporte.handleRequest(request);

    // 6.1: toda respuesta lleva X-Request-Id, tambien la que arma el SDK.
    const cabeceras = new Headers(respuesta.headers);
    cabeceras.set("X-Request-Id", auth.requestId);
    cabeceras.set("Cache-Control", "no-store");

    return new Response(respuesta.body, {
      status: respuesta.status,
      statusText: respuesta.statusText,
      headers: cabeceras,
    });
  } finally {
    await servidor.close();
  }
}
