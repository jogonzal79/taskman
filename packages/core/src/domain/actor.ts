/**
 * Quien pide una escritura y con que correlacion (5.1).
 *
 * Se difirio en F1b.2 a proposito: sin AuditService era un parametro que nadie
 * leia. Ahora tiene un consumidor, y por eso entra de una vez en todas las
 * operaciones de escritura de los tres servicios.
 *
 * DOS diferencias con la 5.1, las dos deliberadas:
 *
 *   - No esta `scopes`. La autorizacion de la 7.2 se resuelve en el BORDE,
 *     antes de llegar aca —`conAuth` exige el scope del endpoint y
 *     `crearHerramientas` monta solo las herramientas que la clave alcanza— y
 *     ningun servicio lo mira: en el contexto seria una lista que nadie lee, que
 *     es exactamente lo que hizo diferir `ctx`.
 *   - `ctx` NO viaja en las lecturas. La 5.1 lo pone en todas las firmas, pero
 *     la 7.4 dice que las lecturas no se auditan, asi que ahi seria de nuevo un
 *     parametro sin lector. El log correlacionado de la 11.1 tampoco lo pidio:
 *     la linea de una lectura la escribe el borde con su request_id
 *     —`registrarPeticion` en REST, la linea `mcp.tool` en MCP— sin que los
 *     servicios lo reciban.
 */

export type ActorType = "USER" | "AGENT" | "API";

export interface ActorContext {
  /**
   * De donde viene la operacion (7.4): USER para la UI web, AGENT para lo que
   * llega por MCP, API para el resto de clientes REST. Lo decide el ADAPTADOR,
   * nunca el llamador. La UI y los bordes MCP lo fijan por construccion, porque
   * saben por donde entro la peticion; el borde REST no lo sabe —una peticion de
   * `HttpPort` y una de curl son iguales en el cable— y lo lee de la clave que
   * autentico (`api_key.actor_type`, desde el paso 12 de F4).
   */
  readonly actorType: ActorType;
  /** Nombre legible del actor: "claude-code", "web-ui". Maximo 120 caracteres. */
  readonly actorName: string;
  /** Prefijo publico de la API key usada, cuando hay una. */
  readonly clientId?: string;
  /** Correlaciona log, auditoria y respuesta. Uno por peticion, no por proceso. */
  readonly requestId: string;
}
