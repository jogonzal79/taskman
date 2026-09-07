import type { ActorContext } from "../domain/actor.js";
import type { Logger } from "../domain/logger.js";
import type { FabricaDeContexto } from "./contexto.js";

/**
 * Lo que sabe UNA invocacion de herramienta, y lo que se pasa hacia adentro.
 *
 * El `ActorContext` se arma UNA vez por invocacion, en el ejecutor
 * (`definirHandler`), y desde ahi baja igual a la escritura que audita y a la
 * linea de log que la registra. Ese es todo el truco de la trazabilidad de la
 * 11.1: el `requestId` de `audit_log` y el de la linea `mcp.tool` no se
 * "coordinan", son el mismo objeto.
 *
 * Antes cada herramienta de escritura llamaba a la fabrica de contexto por su
 * cuenta, en el momento del write. Funcionaba para auditar —un contexto por
 * llamada— pero no habia forma de que el log usara ese mismo id: la resolucion
 * por nombre ocurre ANTES del write, y las cinco herramientas de lectura ni
 * siquiera tenian contexto. Subir la creacion al ejecutor es lo que hace que
 * una resolucion ambigua y la llamada que la produjo compartan correlacion.
 */
export interface Llamada {
  readonly ctx: ActorContext;
  readonly logger: Logger;
}

/**
 * Lo que el registro de herramientas recibe UNA vez, al montarse: de donde sale
 * el contexto de cada llamada y donde se escribe el log.
 *
 * Es la contraparte de `Llamada`: esto es por servidor, aquello es por
 * invocacion.
 */
export interface EntornoMcp {
  readonly contexto: FabricaDeContexto;
  readonly logger: Logger;
}
