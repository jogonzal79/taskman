import type { Logger } from "@taskman/core";
import pino from "pino";

/**
 * El log estructurado en JSON de la 11.1, para el transporte stdio.
 *
 * Aca —y solo aca— vive pino. El nucleo conoce la interfaz `Logger` y nada mas
 * (3.2), asi que esta es la unica pieza que decide el formato y el destino.
 *
 * EL DESTINO ES fd 2, Y NO ES UNA PREFERENCIA. En stdio, fd 1 ES el canal del
 * protocolo: el cliente MCP lee mensajes JSON-RPC delimitados por linea, asi
 * que cada linea de log que caiga en stdout se le entrega como si fuera un
 * mensaje. El destino por defecto de pino es justamente fd 1, de modo que
 * omitir `pino.destination` no deja el log "en un lugar incomodo": lo mete
 * dentro del protocolo.
 *
 * Medido apuntando a proposito el destino a fd 1: stderr queda VACIO, stdout
 * intercala las lineas de pino con las respuestas JSON-RPC, y el cliente de la
 * SDK dispara `transport.onerror` una vez por linea de log, con el error de
 * Zod `invalid_union` cuya primera rama es `expected "2.0"` en `path:
 * ["jsonrpc"]`. Con esta version de la SDK la sesion todavia sobrevive —el
 * `initialize` y la llamada completan— pero cada invocacion ensucia el canal
 * con tantos errores de transporte como lineas registre, y con LOG_LEVEL=debug
 * son varias por herramienta. Lo que decide si eso rompe la sesion o solo la
 * llena de ruido es el cliente, no nosotros: por eso el destino no se negocia.
 * Lo cubre `test/log.test.ts`, que verifica que cada linea de stdout parsee
 * como JSON-RPC.
 *
 * `sync: true` por la misma razon de siempre en un proceso de vida corta: con
 * el destino asincrono, lo que quedo en el buffer cuando el proceso termina no
 * se escribe nunca, y las lineas que mas interesan son las del final.
 */

/** Los cuatro niveles de la 11.2. pino admite mas; el contrato son estos. */
export const NIVELES_LOG = ["debug", "info", "warn", "error"] as const;

export type NivelLog = (typeof NIVELES_LOG)[number];

/** La 11.2 fija `info`: sin configurar se registra la actividad, no el detalle. */
export const NIVEL_LOG_POR_DEFECTO: NivelLog = "info";

/**
 * Valida el valor crudo de LOG_LEVEL.
 *
 * Mismo criterio que `leerPoliticaDestructiva`: ausente o vacia es el valor por
 * defecto, cualquier otra cosa LANZA. La 11.2 lo pide en general, y aca tiene
 * su motivo propio: quien escribio `LOG_LEVEL=verbose` esta buscando un
 * problema, y arrancar en `info` le daria menos lineas de las que cree tener
 * justo cuando esta diagnosticando.
 */
export function leerNivelLog(valor: string | undefined): NivelLog {
  const bruto = (valor ?? "").trim().toLowerCase();
  if (bruto === "") {
    return NIVEL_LOG_POR_DEFECTO;
  }

  const nivel = NIVELES_LOG.find((candidato) => candidato === bruto);
  if (nivel === undefined) {
    throw new Error(
      `LOG_LEVEL="${valor ?? ""}" no es un valor valido. ` +
        `Los valores posibles son: ${NIVELES_LOG.join(", ")}. ` +
        `Sin definir equivale a "${NIVEL_LOG_POR_DEFECTO}".`,
    );
  }

  return nivel;
}

/**
 * El `Logger` que consume el nucleo, escrito a mano sobre pino.
 *
 * Se adapta metodo por metodo en vez de devolver la instancia de pino tal cual,
 * aunque la forma coincida. Asi lo que cruza el limite es exactamente la
 * interfaz de la 11.1 y no la API entera de la libreria: nadie del otro lado
 * puede empezar a usar `child()` o `level` sin que este archivo se entere.
 */
export function crearLogger(nivel: NivelLog): Logger {
  const raiz = pino({ level: nivel }, pino.destination({ fd: 2, sync: true }));

  return {
    debug: (campos, mensaje) => raiz.debug(campos, mensaje),
    info: (campos, mensaje) => raiz.info(campos, mensaje),
    warn: (campos, mensaje) => raiz.warn(campos, mensaje),
    error: (campos, mensaje) => raiz.error(campos, mensaje),
  };
}
