import { randomUUID } from "node:crypto";

import type { ActorContext } from "../domain/actor.js";

/**
 * El `ActorContext` de una llamada MCP (7.4).
 *
 * `actorType` es AGENT por construccion y no por configuracion: todo lo que
 * pasa por este registro llego por MCP, asi que no hay forma de que una
 * herramienta se registre como USER o API ni por error ni a proposito.
 *
 * Aca es donde se recorta el nombre del cliente. El nucleo NO valida longitudes
 * del actor: la que manda es la de las columnas de `audit_log` (4.1), y un
 * `actorName` mas largo que su VARCHAR hace fallar el INSERT de auditoria y con
 * el toda la operacion, que es justamente la garantia de la 7.4. Recortar en el
 * borde evita que el nombre de un cliente decida si se puede crear una tarea;
 * recortarlo en el nucleo, en cambio, escribiria un actor distinto del real sin
 * que nadie se entere.
 */

/** Iguales a los VARCHAR de `audit_log`. */
const LIMITE_ACTOR_NAME = 120;
const LIMITE_REQUEST_ID = 64;

/** Cuando el cliente todavia no se identifico (antes del initialize del SDK). */
export const ACTOR_MCP_DESCONOCIDO = "mcp-desconocido";

export type FabricaDeContexto = () => ActorContext;

function recortar(valor: string, limite: number): string {
  return [...valor].slice(0, limite).join("");
}

export function contextoDeAgente(clientName: string | undefined): ActorContext {
  const nombre = (clientName ?? "").trim();

  return {
    actorType: "AGENT",
    actorName: nombre === "" ? ACTOR_MCP_DESCONOCIDO : recortar(nombre, LIMITE_ACTOR_NAME),
    // Uno por llamada, no por proceso: es lo que correlaciona un registro de
    // auditoria con la peticion que lo produjo (5.1).
    requestId: recortar(randomUUID(), LIMITE_REQUEST_ID),
  };
}

/**
 * El contexto por defecto del registro. Sirve para cualquier montaje que no
 * sepa el nombre del cliente; el transporte que si lo sabe pasa el suyo.
 */
export const CONTEXTO_MCP_POR_DEFECTO: FabricaDeContexto = () => contextoDeAgente(undefined);
