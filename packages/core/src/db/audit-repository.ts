import { Prisma } from "@taskman/db";

import type { ActorType } from "../domain/actor.js";
import type { AuditPayload } from "../domain/audit.js";

/**
 * La fila fisica de `audit_log` (4.1) y como se inserta.
 *
 * No hay un `AuditRepository` con su propia transaccion, y es la decision
 * central de F3: un registro de auditoria NUNCA se escribe por su cuenta. Se
 * inserta con el `tx` de la operacion auditada (7.4), asi que si la operacion
 * falla no queda registro huerfano y si el registro falla la operacion se
 * revierte. Darle transaccion propia haria posible justamente lo contrario.
 */
export interface AuditRow {
  actorType: ActorType;
  actorName: string;
  clientId: string | null;
  action: string;
  entityType: string;
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
}
