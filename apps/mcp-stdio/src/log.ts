import type { Logger, NivelLog } from "@taskman/core";
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

/**
 * El vocabulario de LOG_LEVEL y su validacion VIVEN EN EL NUCLEO
 * (`domain/logger.ts`), al lado de la interfaz `Logger`: son la forma de un valor
 * de configuracion, igual para todos los bordes, y desde que `apps/web` tambien
 * registra una linea por peticion (11.1) habria dos copias de lo mismo. Se
 * reexportan para que este modulo siga siendo el unico sitio del que depende el
 * resto de esta app.
 *
 * Lo que NO se comparte es `crearLogger`, por lo que explica el bloque de arriba:
 * el destino es una decision de cada app, y aca es load-bearing.
 */
export {
  leerNivelLog,
  NIVEL_LOG_POR_DEFECTO,
  NIVELES_LOG,
  type NivelLog,
} from "@taskman/core";

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
