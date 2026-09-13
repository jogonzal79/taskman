import type { AuditRow, AuditTransaction } from "../db/audit-repository";
import type { ActorContext } from "../domain/actor";
import type { AuditEvent } from "../domain/audit";

/**
 * Escribe el registro de auditoria de la 7.4.
 *
 * La firma es la regla: `registrar` solo acepta una transaccion, nunca un
 * cliente suelto. No es una molestia de tipos, es LA garantia de F3: el
 * registro se escribe dentro de la misma transaccion que la operacion auditada,
 * asi que una operacion fallida no deja registro y un registro fallido revierte
 * la operacion. Un metodo que aceptara el cliente global permitiria escribir un
 * registro que sobrevive a la operacion que dice describir, y un log que puede
 * desincronizarse del dato no sirve para reconstruir nada.
 *
 * Es una clase y no una funcion suelta porque es el punto de inyeccion: los
 * tres servicios lo reciben, y una prueba puede darles uno que falle para
 * comprobar que la operacion se revierte de verdad.
 *
 * QUE se registra no se decide aca sino en `domain/audit.ts`, que fija la tabla
 * de la 7.4. Este servicio solo pone el actor y lo escribe.
 */
export class AuditService {
  async registrar(tx: AuditTransaction, ctx: ActorContext, evento: AuditEvent): Promise<void> {
    const fila: AuditRow = {
      actorType: ctx.actorType,
      actorName: ctx.actorName,
      clientId: ctx.clientId ?? null,
      action: evento.action,
      entityType: evento.entityType,
      entityId: evento.entityId,
      beforeData: evento.beforeData,
      afterData: evento.afterData,
      requestId: ctx.requestId,
    };

    await tx.insertAudit(fila);
  }
}
