import {
  consultaDeAuditoria,
  listadoDeAuditoria,
  type RegistroDeAuditoria,
} from "@taskman/contracts";
import { crearCorePort, type AuditEntry, type ListAuditQuery } from "@taskman/core";

import { conAuth } from "../../../lib/auth";
import { leerConsulta } from "../../../lib/consulta";
import { respuestaDeFallo, responder } from "../../../lib/http";
import { registrarContratoRoto } from "../../../lib/log";

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
  // Sin repetibles: los cuatro filtros de la 6.2 son escalares. Un parametro que
  // el contrato no declara sale con 400 y no ignorado, que en este endpoint es lo
  // que evita leer como "filtrado" un log que vino entero.
  const consulta = leerConsulta(request, consultaDeAuditoria, auth);

  if (!consulta.ok) {
    return consulta.respuesta;
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
    limit: consulta.datos.limit,
    ...(consulta.datos.cursor === undefined ? {} : { cursor: consulta.datos.cursor }),
    ...(consulta.datos.entity_type === undefined ? {} : { entityType: consulta.datos.entity_type }),
    ...(consulta.datos.entity_id === undefined ? {} : { entityId: consulta.datos.entity_id }),
    ...(consulta.datos.created_after === undefined
      ? {}
      : { createdAfter: new Date(consulta.datos.created_after) }),
    ...(consulta.datos.created_before === undefined
      ? {}
      : { createdBefore: new Date(consulta.datos.created_before) }),
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
    registrarContratoRoto(auth.requestId, "GET /api/audit", salida.error.issues);

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});
