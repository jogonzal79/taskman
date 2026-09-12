import {
  consultaDeAuditoria,
  listadoDeAuditoria,
  type RegistroDeAuditoria,
} from "@taskman/contracts";
import { crearCorePort, type AuditEntry, type ListAuditQuery } from "@taskman/core";

import { conAuth } from "../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../lib/http.js";

/**
 * GET /api/audit (6.2, RF-10): consulta el registro de auditoria. Scope read
 * —la 7.2 lo dice con todas las letras: "GET sobre todos los recursos, incluido
 * el registro de auditoria"—.
 *
 * NO RECIBE `ActorContext`, y aca no es una asimetria mas sino la regla misma
 * que este endpoint tiene que respetar: la 7.4 dice que las lecturas no se
 * auditan. `contextoDeApi` existe solo para las escrituras, y no llamarlo es lo
 * que hace que este handler no tenga con que escribir un registro aunque
 * quisiera. Ver el comentario del final sobre por que eso no depende de la
 * disciplina de quien lo escriba.
 *
 * Si esta lectura se auditara, cada consulta al log agregaria una fila al log:
 * crece sin limite, se audita a si misma, y la segunda consulta ya devuelve
 * ruido propio en vez del historial del sistema.
 */

// Un log cacheado responde por el estado de otro momento, y este mas que
// ninguno: su contenido cambia con cada escritura del sistema.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/**
 * La traduccion camelCase -> snake_case (6.1), mas la del `id`.
 *
 * `String(entrada.id)` es lo unico no mecanico de esta funcion: `id` es bigint
 * en el dominio porque la columna es BigInt (4.1), y un bigint no sobrevive a
 * `JSON.stringify`. Convertirlo aca, en el borde que serializa, es lo que deja
 * al dominio con el tipo real.
 */
function aSalida(entrada: AuditEntry): RegistroDeAuditoria {
  return {
    id: String(entrada.id),
    actor_type: entrada.actorType,
    actor_name: entrada.actorName,
    client_id: entrada.clientId,
    action: entrada.action,
    entity_type: entrada.entityType,
    entity_id: entrada.entityId,
    before_data: entrada.beforeData,
    after_data: entrada.afterData,
    request_id: entrada.requestId,
    created_at: entrada.createdAt.toISOString(),
  };
}

export const GET = conAuth("read", async (request, auth): Promise<Response> => {
  const parametros = new URL(request.url).searchParams;

  const consulta = consultaDeAuditoria.safeParse({
    limit: parametros.get("limit") ?? undefined,
    cursor: parametros.get("cursor") ?? undefined,
    entity_type: parametros.get("entity_type") ?? undefined,
    entity_id: parametros.get("entity_id") ?? undefined,
    created_after: parametros.get("created_after") ?? undefined,
    created_before: parametros.get("created_before") ?? undefined,
  });

  if (!consulta.success) {
    return respuestaDeError("VALIDATION_ERROR", "Los parametros de la consulta no superan el esquema.", 400, auth, {
      details: { issues: consulta.error.issues },
    });
  }

  /**
   * Los opcionales van condicionales por exactOptionalPropertyTypes, igual que
   * en el resto de los listados.
   *
   * Las dos fechas se convierten a `Date` aca: el contrato las valida como ISO
   * 8601 con zona —texto— y el nucleo las compara como instantes. A diferencia
   * de `due_date`, que es una fecha sola y hay que anclar a medianoche UTC,
   * `created_at` es timestamptz y el ISO completo ya trae su offset: no hay
   * ningun dia que se pueda correr.
   */
  const query: ListAuditQuery = {
    limit: consulta.data.limit,
    ...(consulta.data.cursor === undefined ? {} : { cursor: consulta.data.cursor }),
    ...(consulta.data.entity_type === undefined ? {} : { entityType: consulta.data.entity_type }),
    ...(consulta.data.entity_id === undefined ? {} : { entityId: consulta.data.entity_id }),
    ...(consulta.data.created_after === undefined
      ? {}
      : { createdAfter: new Date(consulta.data.created_after) }),
    ...(consulta.data.created_before === undefined
      ? {}
      : { createdBefore: new Date(consulta.data.created_before) }),
  };

  // La consulta la resuelve `AuditRepository` en una sola lectura sin
  // transaccion: el orden (id DESC), el keyset y los filtros son suyos. El
  // adaptador no corta ni reordena nada en memoria.
  const pagina = await taskman.listAudit(query);

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato
   * que publica, y en este endpoint tiene un trabajo concreto: el `id` es
   * bigint del otro lado, asi que un `String()` que se pierda no llega al
   * cliente como un id raro, ni revienta la serializacion con un TypeError
   * opaco: no pasa `idDeRegistro` y sale como un 500 nuestro, dicho.
   */
  const salida = listadoDeAuditoria.safeParse({
    items: pagina.items.map(aSalida),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de GET /api/audit no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});
