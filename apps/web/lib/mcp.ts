import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  crearCorePort,
  crearHerramientas,
  IDENTIDAD_SERVIDOR_MCP,
  INSTRUCCIONES_MCP,
  leerPoliticaDestructiva,
  montarHerramientas,
  SCOPES,
  type ActorContext,
  type Scope,
} from "@taskman/core";

import { aScopeHttp, limiteSuperado, type Autenticacion } from "./auth";
import { leerCuerpo, responder } from "./http";
import { log } from "./log";
import { consumir, CUBO_POR_SCOPE, type Cubo } from "./rate-limit";

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
 * El scope de cada herramienta, leido del catalogo COMPLETO y no de una lista
 * escrita aca: la columna Scope de la 8.2 ya es un dato de cada definicion (paso
 * 1 de F4), y una copia seria una segunda tabla libre de discrepar.
 *
 * Perezoso: se arma la primera vez que hace falta. Armarlo no toca la base ni el
 * entorno, pero no hay motivo para hacerlo al importar.
 */
let scopePorHerramienta: ReadonlyMap<string, Scope> | undefined;

function scopeDeHerramienta(nombre: string): Scope | undefined {
  scopePorHerramienta ??= new Map(
    crearHerramientas(taskman, { scopes: SCOPES }).map((herramienta) => [
      herramienta.name,
      herramienta.scope,
    ]),
  );

  return scopePorHerramienta.get(nombre);
}

/**
 * QUE CUPO DE LA 7.3 CONSUME UN MENSAJE DE /mcp (D5).
 *
 * El de la HERRAMIENTA, con la misma tabla que REST: `CUBO_POR_SCOPE`. Un
 * `tools/call` a una herramienta de `write` o `delete` cobra escritura; todo lo
 * demas —initialize, notificaciones, tools/list, un tools/call de lectura, una
 * herramienta que no existe— cobra lectura.
 *
 * Es la misma regla que REST y no una nueva. REST elige por el scope del
 * ENDPOINT porque ahi el endpoint ES la operacion; en /mcp la operacion es la
 * herramienta, y su scope ya es un dato. Las alternativas:
 *
 * - Todo a escritura (el cupo mas estrecho): una conexion del cliente de la SDK
 *   gasta cuatro mensajes antes de la primera llamada (initialize,
 *   notifications/initialized, el GET del flujo y tools/list), y listar tareas
 *   le costaria lo mismo que borrarlas. Castiga el protocolo, no el volumen.
 * - Todo a lectura: un agente podria escribir 120 veces por minuto por /mcp y 30
 *   por /api con la MISMA clave, y el limite de escritura dejaria de acotar
 *   escrituras.
 * - Un cupo propio de MCP: la 7.3 nombra dos, y un tercero seria inventar
 *   vocabulario que la especificacion no tiene.
 *
 * Una herramienta que la clave NO tiene igual cobra su cupo, como en REST el 429
 * va antes que el 403: un cliente en bucle contra delete_task sin el scope sigue
 * siendo un cliente en bucle.
 *
 * Un lote JSON-RPC —un arreglo, que protocolos anteriores al 2025-06-18 permiten
 * y el SDK acepta— cobra UN lugar POR MENSAJE, en su cupo. Si no, treinta
 * move_task en un solo POST pasarian por una sola escritura. Si uno de los
 * mensajes no entra, los anteriores del lote ya quedaron cobrados.
 */
export function cuposDeMensajes(cuerpo: unknown): Cubo[] {
  const mensajes = Array.isArray(cuerpo) ? cuerpo : [cuerpo];

  if (mensajes.length === 0) {
    return ["lectura"];
  }

  return mensajes.map((mensaje): Cubo => {
    const { method, params } = (mensaje ?? {}) as { method?: unknown; params?: { name?: unknown } };

    if (method !== "tools/call" || typeof params?.name !== "string") {
      return "lectura";
    }

    const scope = scopeDeHerramienta(params.name);

    return scope === undefined ? "lectura" : CUBO_POR_SCOPE[aScopeHttp(scope)];
  });
}

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
 *
 * EL ORDEN, y por que no es el de REST. `conAuth` cobra el cupo ANTES de leer el
 * cuerpo porque el scope del endpoint ya lo sabe; aca el cupo depende de que
 * mensaje es (`cuposDeMensajes`), asi que primero se lee el cuerpo —ACOTADO a los
 * 256 KB de la 7.3, que es lo mas que cuesta leer antes de saber si hay cupo— y
 * despues se cobra. Toda peticion autenticada cobra, tambien la que termina en
 * 405, 413 o 400: las tres cobran lectura, porque no hay herramienta de la que
 * sacar otro cupo.
 */
export async function atenderMcp(request: Request, auth: Autenticacion): Promise<Response> {
  // El cuerpo lo lee `leerCuerpo` y no el transporte: con su propio `req.json()`
  // el SDK parsearia uno de 50 MB entero. `leerCuerpo` corta el stream al pasar
  // el tope, y lo leido le llega al transporte como `parsedBody`.
  const cuerpo = request.method === "POST" ? await leerCuerpo(request, auth) : undefined;

  const cupos = cuerpo?.ok === true ? cuposDeMensajes(cuerpo.valor) : (["lectura"] as const);

  for (const cubo of cupos) {
    const veredicto = consumir(auth.clave.id, cubo);

    if (!veredicto.permitido) {
      return limiteSuperado(veredicto, auth);
    }
  }

  if (cuerpo === undefined) {
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

  // 413 por el tope, o 400 si no es JSON: la envoltura de la 6.4, como en /api.
  if (!cuerpo.ok) {
    return cuerpo.respuesta;
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

    const respuesta = await transporte.handleRequest(request, { parsedBody: cuerpo.valor });

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
