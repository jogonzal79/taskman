/**
 * Quien pide una escritura y con que correlacion (5.1).
 *
 * Se difirio en F1b.2 a proposito: sin AuditService era un parametro que nadie
 * leia. Ahora tiene un consumidor, y por eso entra de una vez en todas las
 * operaciones de escritura de los tres servicios.
 *
 * DOS diferencias con la 5.1, las dos deliberadas:
 *
 *   - No esta `scopes`. Pertenece a la autenticacion (7.1 y 7.2), que no
 *     existe todavia: declararlo hoy obligaria a cada llamador a inventar una
 *     lista que nadie mira, que es exactamente lo que hizo diferir `ctx`.
 *   - `ctx` NO viaja en las lecturas. La 5.1 lo pone en todas las firmas, pero
 *     la 7.4 dice que las lecturas no se auditan, asi que ahi seria de nuevo un
 *     parametro sin lector. Cuando exista el log correlacionado de la 11.1, las
 *     lecturas van a tener su motivo para recibirlo.
 */

export type ActorType = "USER" | "AGENT" | "API";

export interface ActorContext {
  /**
   * De donde viene la operacion (7.4): USER para la UI web, AGENT para lo que
   * llega por MCP, API para el resto de clientes REST. Lo decide el ADAPTADOR,
   * no el llamador: es el borde el que sabe por donde entro la peticion.
   */
  readonly actorType: ActorType;
  /** Nombre legible del actor: "claude-code", "web-ui". Maximo 120 caracteres. */
  readonly actorName: string;
  /** Prefijo publico de la API key usada, cuando hay una. */
  readonly clientId?: string;
  /** Correlaciona log, auditoria y respuesta. Uno por peticion, no por proceso. */
  readonly requestId: string;
}
