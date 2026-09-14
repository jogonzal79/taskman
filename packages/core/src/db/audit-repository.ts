import { Prisma, type PrismaClient } from "@taskman/db";

import type { ActorType } from "../domain/actor";
import type {
  AuditAction,
  AuditEntityType,
  AuditEntry,
  AuditPayload,
  ListAuditQuery,
} from "../domain/audit";
import type { Page } from "../domain/types";
import { normalizarLimite } from "./pagination";
import { CANAL_DE_CAMBIOS, type AvisoDeCambio } from "./cambios";
import type { TransactionRunner } from "./transaction-runner";

/**
 * La fila fisica de `audit_log` (4.1): como se inserta y como se lee.
 *
 * LA ESCRITURA NO TIENE REPOSITORIO, y es la decision central de F3: un
 * registro de auditoria NUNCA se escribe por su cuenta. Se inserta con el `tx`
 * de la operacion auditada (7.4), asi que si la operacion falla no queda
 * registro huerfano y si el registro falla la operacion se revierte. Darle
 * transaccion propia haria posible justamente lo contrario.
 *
 * `AuditRepository`, mas abajo, es SOLO DE LECTURA y no toca esa regla: no
 * expone ningun camino de escritura, y sus consultas no abren transaccion
 * porque no la necesitan —una lectura no se audita (7.4) y no tiene nada que
 * revertir—. Que la escritura y la lectura no compartan objeto es lo que
 * mantiene la asimetria a la vista.
 */
export interface AuditRow {
  actorType: ActorType;
  actorName: string;
  clientId: string | null;
  /*
   * Los dos con el tipo del DOMINIO y no `string`. Eran `string` y no molestaba
   * mientras la fila solo se insertaba; desde que ademas se PUBLICA (ver
   * `avisarDelCambio`), quien la recibe compara contra literales, y ahi un
   * `string` deja pasar un "TASK" en mayusculas que no matchea nunca. El valor
   * que se escribe no cambia: `AuditService` ya los arma desde `AuditEvent`.
   */
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  beforeData: AuditPayload | null;
  afterData: AuditPayload | null;
  requestId: string | null;
}

/**
 * Lo unico que `AuditService` necesita de una transaccion. Lo cumplen tanto
 * `BoardTransaction` como `TaskTransaction`, que es lo que permite auditar las
 * nueve operaciones de escritura con un solo servicio.
 */
export interface AuditTransaction {
  insertAudit(row: AuditRow): Promise<void>;
}

/**
 * `null` en una columna Json de Prisma es ambiguo —NULL de SQL o `null` de
 * JSON— y hay que elegir: `DbNull` es NULL de SQL, que es lo que la 7.4 pide
 * para el `before_data` de un CREATE y el `after_data` de un DELETE.
 */
function json(payload: AuditPayload | null): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  return payload === null ? Prisma.DbNull : (payload as Prisma.InputJsonValue);
}

export async function insertAuditRow(tx: Prisma.TransactionClient, row: AuditRow): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: row.actorType,
      actorName: row.actorName,
      clientId: row.clientId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData: json(row.beforeData),
      afterData: json(row.afterData),
      requestId: row.requestId,
    },
  });

  await avisarDelCambio(tx, row);
}

/**
 * PUBLICA EL AVISO de la 9.1 —"algo cambio"— por `NOTIFY`, pegado a la
 * escritura del registro de auditoria.
 *
 * VA AQUI Y NO EN OTRO SITIO, y el motivo es el invariante que ya existe: el
 * registro de auditoria se escribe SIEMPRE dentro de la transaccion de la
 * operacion que audita, y esta es la unica funcion que lo escribe. O sea que
 * enganchar el aviso aca le hereda la misma garantia: toda escritura del
 * sistema avisa, y ninguna puede olvidarse, porque olvidarse seria no auditar.
 * Colgarlo de cada servicio serian nueve sitios donde olvidarlo.
 *
 * Y VA DENTRO DE LA TRANSACCION, que es lo que lo hace correcto y no solo
 * comodo: PostgreSQL entrega las notificaciones AL COMMIT. Si la operacion se
 * revierte —o si la reintenta el reintento de 40001— el aviso no sale. Nunca se
 * anuncia un cambio que no ocurrio, y nunca se anuncia dos veces un intento que
 * se abortó. Fuera de la transaccion habria que elegir entre avisar de mas o
 * avisar de menos.
 *
 * `pg_notify` COMO FUNCION y no la sentencia `NOTIFY`: la sentencia toma el
 * canal y el texto como literales y no admite parametros, asi que habria que
 * interpolar el JSON en el SQL. La funcion los recibe bindeados.
 *
 * NO ROMPE LA OPERACION SI FALLA. Un aviso perdido degrada la pantalla a lo que
 * era antes de este paso —hay que recargar para ver el cambio— mientras que
 * revertir una escritura buena porque no se pudo avisar de ella cambia un
 * problema de refresco por uno de datos. Se traga la falla a proposito; el
 * `catch` es la unica parte de esta funcion que NO comparte el destino de la
 * transaccion, y es asi queriendo.
 */
async function avisarDelCambio(tx: Prisma.TransactionClient, row: AuditRow): Promise<void> {
  const aviso: AvisoDeCambio = {
    actor: row.actorType,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    requestId: row.requestId,
  };

  try {
    await tx.$queryRaw`SELECT pg_notify(${CANAL_DE_CAMBIOS}, ${JSON.stringify(aviso)})`;
  } catch {
    // Ver arriba: el refresco de la pantalla no puede tumbar una escritura.
  }
}

// --- Lectura (6.2, RF-10) ----------------------------------------------------

/**
 * El cursor de este listado, opaco para el llamador: el `id` de la ultima fila
 * devuelta, en texto y en base64url, con la misma envoltura JSON que usan los
 * otros listados.
 *
 * NO se reutiliza `codificarCursor` de `pagination.ts` y no es por descuido:
 * ese keyset castea el desempate con `::uuid` y ordena `id ASC`, y aca el `id`
 * es bigint y el orden es DESC. Parametrizar aquella funcion para este caso
 * tocaria los cuatro listados que ya andan; quince lineas propias no tocan
 * ninguno.
 */
function codificarCursorDeAuditoria(id: bigint): string {
  return Buffer.from(JSON.stringify({ id: id.toString() }), "utf8").toString("base64url");
}

/**
 * Devuelve undefined ante cualquier cosa que no decodifique a un entero.
 *
 * Que un cursor invalido se IGNORE —y devuelva la primera pagina en vez de un
 * 400— es el comportamiento heredado de `decodificarCursor`, que ya tienen GET
 * /api/boards, GET /api/tasks y la busqueda. Se repite a proposito: que los
 * cinco listados respondan igual vale mas que arreglarlo en uno solo, y el dia
 * que se decida que tiene que ser 400 es un cambio de los cinco a la vez.
 */
function decodificarCursorDeAuditoria(cursor: string): bigint | undefined {
  try {
    const crudo: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof crudo !== "object" || crudo === null) {
      return undefined;
    }
    const { id } = crudo as { id?: unknown };
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      return undefined;
    }
    return BigInt(id);
  } catch {
    return undefined;
  }
}

/**
 * Al LEER, el NULL de SQL vuelve como `null` a secas: los centinelas
 * `DbNull` / `JsonNull` son de entrada y no aparecen en el resultado. Y un
 * `null` de JSON guardado tampoco se distingue, porque no lo escribimos nunca:
 * `json()` de arriba manda `DbNull` para el payload ausente.
 */
function payload(valor: Prisma.JsonValue | null): AuditPayload | null {
  return valor === null ? null : (valor as AuditPayload);
}

/**
 * Lectura del registro de auditoria. SOLO lectura: no hay aca ningun camino
 * para escribir una fila, que es lo que sostiene la regla de la 7.4.
 */
export class AuditRepository {
  readonly #runner: TransactionRunner;

  constructor(runner: TransactionRunner) {
    this.#runner = runner;
  }

  get #prisma(): PrismaClient {
    return this.#runner.prisma;
  }

  /**
   * Pagina keyset por `id DESC`: mas reciente primero, que es lo util en un log.
   *
   * SE ORDENA POR `id` Y NO POR `created_at`, y no es un atajo. `created_at` es
   * `timestamp(3)` y una sola transaccion puede escribir varias filas con el
   * mismo valor, asi que como clave de paginacion admite empates y un empate en
   * el borde de pagina saltea o repite filas. El `id` es una secuencia: no
   * empata nunca, y por eso el recorrido completo devuelve exactamente el
   * conjunto.
   *
   * Lo que se paga por eso conviene decirlo: bajo concurrencia el orden de `id`
   * es el de ASIGNACION y no el de COMMIT, asi que una fila puede aparecer una
   * posicion mas abajo de lo que su `created_at` sugiere. No se pierde ni se
   * repite —un id mas alto siempre es una fila mas nueva— que es la garantia
   * que importa para paginar.
   */
  async listAudit(query: ListAuditQuery): Promise<Page<AuditEntry>> {
    const limite = normalizarLimite(query.limit);
    const cursor =
      query.cursor === undefined ? undefined : decodificarCursorDeAuditoria(query.cursor);

    const filas = await this.#prisma.auditLog.findMany({
      where: {
        ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
        ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
        ...(query.createdAfter === undefined && query.createdBefore === undefined
          ? {}
          : {
              createdAt: {
                ...(query.createdAfter === undefined ? {} : { gt: query.createdAfter }),
                ...(query.createdBefore === undefined ? {} : { lt: query.createdBefore }),
              },
            }),
        // Keyset: estrictamente "mas viejo que el cursor" en un orden DESC.
        ...(cursor === undefined ? {} : { id: { lt: cursor } }),
      },
      orderBy: { id: "desc" },
      // Una fila de mas para saber si hay pagina siguiente, igual que los otros.
      take: limite + 1,
    });

    const hayMas = filas.length > limite;
    const pagina = hayMas ? filas.slice(0, limite) : filas;
    const ultima = pagina.at(-1);

    return {
      items: pagina.map((fila) => ({
        id: fila.id,
        actorType: fila.actorType,
        actorName: fila.actorName,
        clientId: fila.clientId,
        action: fila.action,
        entityType: fila.entityType,
        entityId: fila.entityId,
        beforeData: payload(fila.beforeData),
        afterData: payload(fila.afterData),
        requestId: fila.requestId,
        createdAt: fila.createdAt,
      })),
      nextCursor: hayMas && ultima !== undefined ? codificarCursorDeAuditoria(ultima.id) : null,
    };
  }
}
