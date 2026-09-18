import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { crearCorePort, SCOPES, type Logger, type Scope, type TaskManagerPort } from "@taskman/core";

import { validarEntorno, type Entorno } from "./config";
import { HttpPort } from "./http-port";
import { crearLogger } from "./log";
import { crearServidorMcp } from "./server";

/**
 * Entrypoint del transporte stdio (8.1), en sus dos modos:
 *
 * - `core`: Claude Code en la misma maquina que la base de datos. Los servicios
 *   corren en este proceso y hablan con PostgreSQL.
 * - `http`: Claude Code local contra un servidor remoto, que la 8.1 llama "caso
 *   habitual". Este proceso no toca la base: habla con `/api` con una API key.
 *
 * Lo unico que cambia entre los dos es QUE `TaskManagerPort` se monta y de donde
 * salen los scopes. El catalogo de herramientas, el transporte y todo lo demas
 * son los mismos, que es el punto entero de la ADR-003.
 *
 * Nada puede escribir en stdout salvo los mensajes del protocolo: stdout ES el
 * canal MCP. Todo diagnostico va a stderr.
 */

/**
 * Escribe el motivo en stderr, marca el proceso como fallido y devuelve
 * `undefined` para que quien lo llame corte.
 *
 * NO LLAMA A `process.exit()`, Y ESO ES LOAD-BEARING DESDE EL MODO HTTP.
 * `process.exit()` despues de un `fetch` ABORTA el proceso en Windows: libuv
 * dispara `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
 * src\win\async.c, line 76` y el proceso muere con 0xC0000409 (3221226505) en
 * vez de con 1. MEDIDO con la sonda de scopes contra un servidor que devuelve
 * 401: el mensaje sale entero —lo bueno— pero el codigo de salida es el del
 * aborto, que para quien lo mire es un crash y no una configuracion mal puesta.
 *
 * Marcar `exitCode` y dejar que el proceso termine solo da 1 y no cuesta nada:
 * si el arranque no llega a montar el transporte, no queda ningun handle vivo y
 * el loop se vacia enseguida. Medido con el servidor arriba y las conexiones
 * keep-alive de undici abiertas: 1 ms.
 */
function fallar(mensaje: string): undefined {
  process.stderr.write(`[taskman-mcp] ${mensaje}\n`);
  process.exitCode = 1;

  return undefined;
}

/**
 * TODA la configuracion de la 11.2, de una vez y antes de tocar la base o la
 * red.
 *
 * Eran cuatro bloques sueltos —MCP_PORT_MODE contra un Set, DATABASE_URL no
 * vacia, y la politica destructiva y el nivel de log con un try/catch cada uno—
 * y la primera que fallaba tapaba a las demas: arrancar sin `.mcp.json` obligaba
 * a un reinicio por variable. El esquema las junta y el mensaje las lista todas.
 */
function configuracion(): Entorno | undefined {
  try {
    return validarEntorno(process.env);
  } catch (error: unknown) {
    return fallar(error instanceof Error ? error.message : String(error));
  }
}

interface Montaje {
  readonly port: TaskManagerPort;
  /** Los de la 7.2 con los que se filtra el catalogo (8.1). */
  readonly scopes: readonly Scope[];
}

/**
 * El puerto del modo configurado, y los scopes con los que montar el catalogo.
 *
 * LOS SCOPES SON LA ASIMETRIA ENTRE LOS DOS MODOS, y no es una diferencia de
 * comodidad:
 *
 * - En `core` van los TRES, porque no hay ninguna clave de la que leerlos. Quien
 *   arranca este proceso tiene DATABASE_URL, que autoriza mas que cualquier
 *   scope de la 7.2, asi que recortarle herramientas no protegeria nada.
 * - En `http` SI hay clave, y la 8.1 pide que su catalogo sea el de esa clave:
 *   "un cliente sin scope delete no ve disponible la herramienta delete_task".
 *   Salen de `descubrirScopes()`, que se lo pregunta al servidor; el porque de
 *   ese mecanismo esta entero en `http-port.ts`.
 *
 * El `catch` cubre las dos formas de no poder arrancar en modo http —la clave
 * rechazada con 401 y un catalogo vacio, que `crearHerramientas` rechaza— y las
 * dos salen por el mismo `fallar`, o sea con un mensaje en stderr y sin traza:
 * son configuracion, no un bug.
 */
async function armarPuerto(config: Entorno, logger: Logger): Promise<Montaje | undefined> {
  if (config.MCP_PORT_MODE === "core") {
    return { port: crearCorePort(), scopes: SCOPES };
  }

  try {
    const port = new HttpPort({
      baseUrl: config.TASKMAN_API_URL,
      apiKey: config.TASKMAN_API_KEY,
      logger,
    });

    const { scopes, indeterminados } = await port.descubrirScopes();

    if (indeterminados.length > 0) {
      // Se anuncian herramientas que la clave puede no tener: el agente va a
      // recibir el 403 al ejecutarlas. Es un warn y no un fallo (ver
      // `descubrirScopes`), pero tiene que quedar dicho, porque es la unica
      // situacion en que el catalogo no corresponde a la clave.
      logger.warn(
        {
          evt: "mcp.scopes",
          mode: "http",
          scopes: enMinuscula(scopes),
          undetermined: enMinuscula(indeterminados),
        },
        "no se pudieron medir todos los scopes de la clave; se dan por concedidos",
      );
    }

    return { port, scopes };
  } catch (error: unknown) {
    return fallar(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Los scopes como los escribe el resto del sistema de cara afuera (7.2): en
 * minuscula, igual que en `apikey:create`, en el `granted_scopes` del 403 y en
 * la 8.1. Es una linea de log, asi que se calcula aca en vez de importar la
 * tabla del borde REST, que vive en la otra app.
 */
function enMinuscula(scopes: readonly Scope[]): string[] {
  return scopes.map((scope) => scope.toLowerCase());
}

/**
 * Los `return` tempranos son el unico camino a un arranque fallido: cada uno
 * viene de un `fallar()` que ya dejo el motivo en stderr y el codigo en 1. Lo
 * que NO pasa en ese camino es conectar el transporte, y de eso depende que el
 * proceso termine solo (ver `fallar`).
 */
async function arrancar(): Promise<void> {
  const config = configuracion();

  if (config === undefined) {
    return;
  }

  // Escribe a fd 2 con destino sincrono: ver el porque en ./log.ts. Una linea de
  // log en stdout no es un log mal ubicado, es un mensaje corrupto del protocolo.
  const logger = crearLogger(config.LOG_LEVEL);

  const montaje = await armarPuerto(config, logger);

  if (montaje === undefined) {
    return;
  }

  const servidor = crearServidorMcp(montaje.port, {
    scopes: montaje.scopes,
    politicaDestructiva: config.MCP_DESTRUCTIVE_POLICY,
    logger,
  });

  await servidor.connect(new StdioServerTransport());

  logger.info(
    {
      evt: "mcp.ready",
      mode: config.MCP_PORT_MODE,
      transport: "stdio",
      // Con que clave se esta hablando no se puede decir —este proceso solo tiene
      // la clave en claro, no su etiqueta— pero QUE PUEDE HACER si, y es lo que
      // explica un catalogo mas corto de lo esperado sin tener que listarlo.
      scopes: enMinuscula(montaje.scopes),
      destructivePolicy: config.MCP_DESTRUCTIVE_POLICY,
      logLevel: config.LOG_LEVEL,
    },
    "servidor listo",
  );
}

await arrancar();
