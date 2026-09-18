import type { ActorContext } from "@taskman/core";

import { nuevoRequestId } from "./http";

/**
 * El `ActorContext` de una escritura hecha desde la UI web (7.4).
 *
 * Es el TERCER borde que arma uno, y ninguno deja que el llamador elija su
 * `actorType`: `contextoDeAgente` pone AGENT, este pone USER, y `contextoDeApi`
 * lo lee de la clave que autentico (`api_key.actor_type`: API, o AGENT si se
 * emitio con `apikey:create --agent`), porque REST no ve por donde entro la
 * peticion. La 7.4 lo dice como una derivacion —"actor_type se deriva del
 * origen"— y la unica forma de que sea de verdad una derivacion y no una
 * convencion es que ningun llamador pueda elegirla. Por eso esto no recibe el
 * tipo por parametro ni lo lee de la configuracion: una Server Action no tiene
 * con que registrarse como AGENT ni por error ni a proposito.
 *
 * ES LA PRIMERA VEZ QUE USER SE USA. Estaba declarado en `ActorType` desde F1b.2
 * y hasta hoy ninguna escritura lo producia, porque los dos bordes que escribian
 * eran REST y MCP. Si alguna vez aparece una fila de `audit_log` con USER que no
 * salio de aca, es un bug: este modulo es el unico productor.
 *
 * `actorName` es "web-ui", que es el ejemplo que da la 5.1 para este campo
 * ("p.ej. 'claude-code' o 'web-ui'"). Es una CONSTANTE y no el nombre de una
 * persona: no hay usuarios en el sistema —la 1.2 lo deja fuera y la
 * autenticacion de la 7.1 es por clave de API, que la UI no usa— asi que
 * inventar un nombre por sesion escribiria en la auditoria un dato que nadie
 * puede verificar. Cuando haya identidad de usuario, el que cambia es este
 * archivo y ningun otro.
 *
 * `clientId` NO VA, y va ausente en vez de en null: es "el prefijo de la API key
 * usada" (5.1) y la UI no usa ninguna —invoca los servicios en el mismo proceso,
 * sin pasar por su propia API publica (9.1)—. Con `exactOptionalPropertyTypes`
 * ausente y presente-en-undefined son distinguibles en el tipo, y el que
 * corresponde es ausente; `AuditService` lo traduce a NULL en la columna, que es
 * lo que significa "esta escritura no vino de ninguna clave".
 *
 * El `requestId` sale de la MISMA `nuevoRequestId()` que usa `conAuth`, con el
 * mismo prefijo `req_`: es lo que hace que un registro de auditoria escrito por
 * la UI y uno escrito por REST se busquen igual (6.1). Uno por ACCION, no por
 * proceso ni por render.
 */

/** Lo que la 5.1 propone como ejemplo para este mismo campo. */
export const ACTOR_UI = "web-ui";

export function contextoDeUi(): ActorContext {
  return {
    actorType: "USER",
    actorName: ACTOR_UI,
    requestId: nuevoRequestId(),
  };
}
