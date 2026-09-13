import type { EscrituraIdempotente } from "../db/idempotency-repository.js";

/**
 * Un participante en la transaccion de una operacion de escritura.
 *
 * POR QUE EXISTE. La 6.5 pide guardar el cuerpo de la respuesta "en la misma
 * transaccion" que la operacion. Pero ese cuerpo no lo conoce el nucleo: lo arma
 * el adaptador, que traduce a snake_case y valida contra el contrato publico
 * (6.1). O sea que el dato que hay que escribir adentro de la transaccion se
 * calcula afuera, y la unica forma de juntarlos es que el adaptador entre.
 *
 * QUE RECIBE, Y QUE NO. Recibe el resultado ya construido —lo necesita para
 * proyectar el cuerpo— y una `EscrituraIdempotente`, que es una interfaz de UN
 * SOLO metodo. NO recibe la transaccion: ver el comentario de
 * `EscrituraIdempotente`. Esa diferencia es lo que hace aceptable abrir la
 * transaccion a un tercero, porque deja intactos los tres candados del
 * invariante de auditoria de la 7.4:
 *
 *   1. `AuditService.registrar()` sigue siendo el unico camino a `audit_log`, y
 *      sigue exigiendo una transaccion. El participante no tiene `insertAudit`.
 *   2. El evento lo sigue armando `domain/audit.ts` a partir de la operacion, no
 *      el llamador.
 *   3. El registro se sigue escribiendo DENTRO del intento: como el participante
 *      corre dentro de la misma transaccion, un intento abortado se lleva su
 *      fila de auditoria Y la de idempotencia juntas. Si el participante corriera
 *      despues del commit, una operacion reintentada dejaria su registro de
 *      idempotencia apuntando a un intento que no fue.
 *
 * Es opcional en la firma: sin cabecera `Idempotency-Key` no hay participante y
 * la operacion se comporta exactamente como antes de que esto existiera.
 */
export type ParticipanteIdempotente<T> = (
  resultado: T,
  escritura: EscrituraIdempotente,
) => Promise<void>;
