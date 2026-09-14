import type { ActorType } from "../domain/actor";
import type { AuditAction, AuditEntityType } from "../domain/audit";

/**
 * EL AVISO DE QUE ALGO CAMBIO, publicado por PostgreSQL con `NOTIFY`.
 *
 * Este modulo es solo el VOCABULARIO —el nombre del canal y la forma del
 * mensaje— y no habla con la base. Lo comparten dos lados que no se importan
 * entre si: el que publica, que es el adaptador Prisma del nucleo
 * (`insertAuditRow`), y el que escucha, que es una conexion `pg` cruda en
 * `apps/web`. Prisma no puede escuchar —`LISTEN` es una notificacion asincrona
 * del protocolo, no una consulta— asi que los dos extremos usan clientes
 * distintos y lo unico que puede mantenerlos de acuerdo es este archivo.
 *
 * ES UNA HOJA a proposito: importa un tipo y nada mas. Lo pide un Route Handler
 * de `apps/web`, y ahi la regla del proyecto es no arrastrar el barrel del
 * nucleo (ver `lib/config.ts`).
 */

/**
 * El canal. Uno solo para todo el sistema, sin partir por tablero ni por
 * entidad: lo que hay que detectar es "algo cambio", no "que cambio", y un
 * canal por tablero obligaria a que quien escucha sepa de antemano cuales
 * existen y a re-suscribirse cuando aparezca otro.
 *
 * El nombre es un identificador de PostgreSQL, asi que va en minusculas y sin
 * comillas: `LISTEN taskman_cambios` y `NOTIFY taskman_cambios` tienen que
 * plegar al mismo nombre.
 */
export const CANAL_DE_CAMBIOS = "taskman_cambios";

/**
 * Lo que viaja en el aviso. Es la IDENTIDAD de la fila de auditoria que lo
 * disparo, no la entidad que cambio: ni el titulo, ni la columna, ni las
 * posiciones.
 *
 * Y eso es deliberado. Mandar el cambio entero convertiria a esto en un segundo
 * camino de lectura —uno que replica lo que el Server Component ya sabe hacer y
 * que se desincronizaria en cuanto la pantalla mostrara un campo mas—. El aviso
 * solo dice "mira otra vez, y de paso: fue este actor sobre esta entidad".
 *
 * `actor` y `entityId` no son decoracion: el actor decide si la pantalla marca
 * el cambio —solo se marcan AGENT y API (7.4)— y el `entityId` dice a que
 * tarjeta ponerle la marca. `requestId` es con lo que la pestaña que escribio
 * intenta reconocer su propio aviso para no refrescar de mas; hoy no llega a
 * tiempo (ver la deuda en CLAUDE.md), y no interviene en la marca.
 */
export interface AvisoDeCambio {
  /** USER es la UI, AGENT es MCP, API es el resto de clientes REST (7.4). */
  actor: ActorType;
  /** CREATE, UPDATE, MOVE o DELETE (7.4). */
  action: AuditAction;
  /**
   * `board`, `column` o `task`. EN MINUSCULAS, que es como lo escribe el dominio
   * (`AuditEntityType`) y como queda en la columna `entity_type`.
   *
   * Se declara con el tipo del dominio y no como `string` a proposito: quien lea
   * este aviso va a comparar contra un literal, y con `string` un `"TASK"` en
   * mayusculas compila y no matchea nunca. Costo una tanda de pruebas rojas
   * descubrirlo —las tarjetas se refrescaban y no se marcaba ninguna— y el tipo
   * es lo unico que lo convierte en un error de compilacion.
   */
  entityType: AuditEntityType;
  entityId: string;
  /** El mismo `X-Request-Id` de la 6.1 que devolvio la respuesta, si lo hubo. */
  requestId: string | null;
}

/**
 * Interpreta el texto de una notificacion. Devuelve `undefined` si no tiene la
 * forma esperada, en vez de lanzar: quien escucha es un bucle de larga vida y un
 * mensaje raro —de otra version del proceso, o de alguien probando con psql— no
 * puede tirarlo abajo.
 */
export function leerAvisoDeCambio(texto: string | undefined): AvisoDeCambio | undefined {
  if (texto === undefined || texto === "") {
    return undefined;
  }

  let crudo: unknown;

  try {
    crudo = JSON.parse(texto);
  } catch {
    return undefined;
  }

  if (typeof crudo !== "object" || crudo === null) {
    return undefined;
  }

  const objeto = crudo as Record<string, unknown>;
  const actor = objeto["actor"];
  const action = objeto["action"];
  const entityType = objeto["entityType"];
  const entityId = objeto["entityId"];
  const requestId = objeto["requestId"];

  if (
    !esActor(actor) ||
    !esAccion(action) ||
    !esEntidad(entityType) ||
    typeof entityId !== "string"
  ) {
    return undefined;
  }

  return {
    actor,
    action,
    entityType,
    entityId,
    requestId: typeof requestId === "string" ? requestId : null,
  };
}

/**
 * Los tres vocabularios, comprobados contra listas y no contra `typeof`.
 *
 * `satisfies` los ata a los tipos del dominio: si `AuditAction` gana un valor y
 * nadie lo agrega aca, esto NO COMPILA, en vez de descartar en silencio los
 * avisos de esa accion. Es la misma salvaguarda del mapa de prioridades de
 * `lib/prioridad.ts`.
 */
const ACTORES = ["USER", "AGENT", "API"] as const satisfies readonly ActorType[];
const ACCIONES = ["CREATE", "UPDATE", "MOVE", "DELETE"] as const satisfies readonly AuditAction[];
const ENTIDADES = ["board", "column", "task"] as const satisfies readonly AuditEntityType[];

function esActor(valor: unknown): valor is ActorType {
  return typeof valor === "string" && (ACTORES as readonly string[]).includes(valor);
}

function esAccion(valor: unknown): valor is AuditAction {
  return typeof valor === "string" && (ACCIONES as readonly string[]).includes(valor);
}

function esEntidad(valor: unknown): valor is AuditEntityType {
  return typeof valor === "string" && (ENTIDADES as readonly string[]).includes(valor);
}
