import {
  leerNivelLog,
  type ActorType,
  type CamposDeLog,
  type Logger,
  type NivelLog,
} from "@taskman/core";
import pino from "pino";

/**
 * El log estructurado en JSON de la 11.1 para el borde REST.
 *
 * Aca —y solo aca— vive pino en `apps/web`. El nucleo conoce la interfaz `Logger`
 * y nada mas (3.2), asi que este es el unico modulo que decide el formato y el
 * destino, igual que `apps/mcp-stdio/src/log.ts` lo es para stdio.
 *
 * EL DESTINO ES fd 1, y es la diferencia con la otra app: ahi stdout ES el canal
 * del protocolo MCP y el log tiene que ir al fd 2 para no meterse dentro de los
 * mensajes; aca stdout es donde un servidor escribe su log y donde lo recoge el
 * contenedor (11.3). Es por esa diferencia que `crearLogger` NO se comparte entre
 * las dos apps aunque el vocabulario de LOG_LEVEL si: el destino no es un detalle
 * de configuracion, es la decision que cada borde tiene que tomar sabiendo por
 * que canal habla.
 *
 * `sync: true` por lo mismo que en stdio, y con un motivo extra: las lineas que
 * mas interesan son las de los 500, o sea justo las que un proceso que se esta
 * cayendo dejaria en el buffer sin escribir.
 */

/** El tipo que pino acepta como destino: cualquier cosa con `write`. */
export type Destino = pino.DestinationStream;

/**
 * Un `Logger` sobre pino, adaptado metodo por metodo.
 *
 * Se adapta en vez de devolver la instancia tal cual, igual que en stdio: lo que
 * cruza el limite es exactamente la interfaz de la 11.1 y no la API entera de la
 * libreria.
 *
 * `destino` se inyecta SOLO para las pruebas, que asi ejercitan pino de verdad
 * —el JSON, el filtrado por nivel— contra un buffer en memoria en vez de contra
 * el fd 1 del proceso que corre la suite.
 */
export function crearLogger(nivel: NivelLog, destino?: Destino): Logger {
  const raiz = pino({ level: nivel }, destino ?? pino.destination({ fd: 1, sync: true }));

  return {
    debug: (campos, mensaje) => raiz.debug(campos, mensaje),
    info: (campos, mensaje) => raiz.info(campos, mensaje),
    warn: (campos, mensaje) => raiz.warn(campos, mensaje),
    error: (campos, mensaje) => raiz.error(campos, mensaje),
  };
}

/**
 * Colgado de `globalThis` y construido en el PRIMER USO, por dos razones
 * distintas y las dos ya pagadas en este repo.
 *
 * Perezoso, porque construirlo al evaluar el modulo leeria LOG_LEVEL al importar,
 * y un valor invalido LANZA: eso rompe el "Collecting page data" de `next build`,
 * que importa cada Route Handler sin ejecutar nada. Es la misma trampa que
 * resolvieron el proxy de `packages/db` y el `ApiKeyService` por peticion.
 *
 * En `globalThis` y no en una variable de modulo, por lo mismo que el registro
 * del limite de peticiones: Next arma un grafo por ruta, asi que una variable de
 * modulo puede terminar siendo una por endpoint, y ahi serian N instancias de
 * pino abriendo N destinos sobre el mismo fd.
 */
const globalParaLog = globalThis as typeof globalThis & { __taskmanLogWeb?: Logger };

export function log(): Logger {
  globalParaLog.__taskmanLogWeb ??= crearLogger(leerNivelLog(process.env["LOG_LEVEL"]));

  return globalParaLog.__taskmanLogWeb;
}

/**
 * Reemplaza el logger del proceso. La suite lo usa para callarlo y para poder
 * AFIRMAR sobre las lineas; `undefined` lo devuelve a su estado inicial.
 */
export function fijarLogger(logger: Logger | undefined): void {
  if (logger === undefined) {
    delete globalParaLog.__taskmanLogWeb;

    return;
  }

  globalParaLog.__taskmanLogWeb = logger;
}

export interface PeticionRegistrada {
  /**
   * El tipo de actor de la 7.4, que nunca lo decide la peticion. En REST lo
   * rotula la CLAVE que autentico, igual que `contextoDeApi` para la auditoria,
   * y API es solo el valor del borde cuando no se identifico ninguna (`conAuth`);
   * en /mcp es AGENT por construccion (`conAuthMcp`). Obligatorio y sin valor por
   * defecto: un borde nuevo que registre su linea tiene que decir cual es.
   */
  readonly actorType: ActorType;
  readonly requestId: string;
  readonly metodo: string;
  /** Solo el camino, sin query: ver la nota de abajo. */
  readonly ruta: string;
  readonly status: number;
  readonly duracionMs: number;
  /** Prefijo PUBLICO de la clave, o null si la peticion no autentico. */
  readonly clientId: string | null;
}

/**
 * La linea por peticion de la 11.1, con sus siete piezas: request_id, metodo,
 * ruta, codigo de estado, duracion, prefijo de la clave y tipo de actor.
 *
 * Las siete van SIEMPRE, y las que no se sepan van en null en vez de faltar: un
 * 401 no tiene clave, y una linea con `client_id: null` dice eso, mientras una
 * linea sin el campo obliga a adivinar si no habia clave o si el log cambio de
 * forma. Las peticiones que no autentican son justamente las que uno quiere ver.
 *
 * `client_id` y no `key_prefix` a proposito: es el mismo valor que `audit_log`
 * guarda en su columna `client_id` (5.1), y con el mismo nombre en los dos lados
 * el log y la auditoria se cruzan sin traducir nada.
 *
 * LA RUTA VA SIN QUERY, y no es solo porque la 11.1 diga "ruta": el `?q=` de la
 * busqueda lleva texto que escribio una persona, y una linea de log no es el
 * lugar de los titulos de las tareas de nadie. La clave nunca puede aparecer: va
 * en la cabecera Authorization y este modulo no la ve (7.3).
 *
 * El nivel lo decide el estado: `error` para 5xx, `info` para el resto. Un 4xx es
 * una peticion mal hecha, no un fallo del servidor.
 */
export function registrarPeticion(peticion: PeticionRegistrada): void {
  const campos: CamposDeLog = {
    request_id: peticion.requestId,
    method: peticion.metodo,
    route: peticion.ruta,
    status: peticion.status,
    duration_ms: peticion.duracionMs,
    client_id: peticion.clientId,
    actor_type: peticion.actorType,
  };

  if (peticion.status >= 500) {
    log().error(campos, "peticion");

    return;
  }

  log().info(campos, "peticion");
}

/**
 * La traza del error se arma a mano en vez de confiar en el serializador de pino:
 * asi el `stack` esta en la linea con independencia de como se configure la
 * libreria, que es lo que la 11.1 pide para los 500, y lo que va queda a la
 * vista de quien lee esta funcion.
 */
function aTraza(error: unknown): CamposDeLog {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack: error.stack ?? null,
      ...(error.cause === undefined ? {} : { cause: String(error.cause) }),
    };
  }

  return { type: typeof error, message: String(error), stack: null };
}

/**
 * El 500 de la 11.1: la traza COMPLETA al log, y al cliente solo el codigo y el
 * request_id. Las dos mitades de la misma frase, y esta es la del log; la otra la
 * sostiene `respuestaDeFallo`, que responde INTERNAL_ERROR sin detalle.
 */
export function registrarFallo(requestId: string, error: unknown): void {
  log().error({ request_id: requestId, err: aTraza(error) }, "fallo no controlado");
}

/**
 * La sonda de /api/health no pudo hablar con la base (11.1). Es un fallo real del
 * sistema, asi que va a nivel error aunque la respuesta que recibe el cliente sea
 * un 503 perfectamente valido: lo que esta roto es la base, no la peticion.
 */
export function registrarSondaCaida(requestId: string, error: unknown): void {
  log().error({ request_id: requestId, err: aTraza(error) }, "la sonda a la base fallo");
}

/**
 * Una respuesta que no cumple el contrato que su endpoint publica. Es un bug
 * nuestro y termina en 500, pero lo que hace falta para diagnosticarlo son los
 * `issues` de Zod, que el 500 no lleva.
 */
export function registrarContratoRoto(
  requestId: string,
  operacion: string,
  issues: unknown,
): void {
  log().error(
    { request_id: requestId, operation: operacion, issues },
    "la respuesta no cumple el contrato",
  );
}
