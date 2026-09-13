import type { AuditEntry, ListAuditQuery } from "../domain/audit";
import type { AuditRepository } from "../db/audit-repository";
import type { Page } from "../domain/types";

/**
 * Lectura del registro de auditoria (6.2, RF-10).
 *
 * VA APARTE DE `AuditService` Y NO COMO UN METODO MAS SUYO, que es la decision
 * de este paso. `AuditService` tiene un solo metodo y una firma que solo acepta
 * una transaccion, y esa firma ES el invariante de la 7.4: hace imposible
 * escribir un registro fuera de la transaccion que audita, sin depender de la
 * disciplina de quien llama. Un metodo de lectura que —correctamente— no recibe
 * transaccion diluiria justamente eso: la clase pasaria a tener dos metodos con
 * dos reglas distintas y el lector tendria que saber cual es cual. Separarlos
 * deja que cada clase diga una sola cosa.
 *
 * El motivo practico va en el mismo sentido: `AuditService` hoy se construye
 * con `new AuditService()` y se COMPARTE entre los tres servicios de escritura,
 * asi que darle un repositorio le cambiaria el constructor a los tres sitios
 * que lo arman, para algo que ninguno de los tres usa.
 *
 * No tiene reglas de negocio y no las esconde: existe como costura, para que el
 * adaptador no importe Prisma (regla de dependencias de CLAUDE.md) y para que
 * el dia que la lectura tenga una regla —retencion, redaccion de payloads—
 * haya un lugar donde ponerla que no sea el handler.
 */
export class AuditQueryService {
  readonly #audit: AuditRepository;

  constructor(audit: AuditRepository) {
    this.#audit = audit;
  }

  /**
   * Mas reciente primero, paginado por cursor.
   *
   * NO recibe `ActorContext`, igual que el resto de las lecturas del nucleo: la
   * 7.4 dice que las lecturas no se auditan, asi que aca seria un parametro sin
   * lector. Ver el comentario de `domain/actor.ts`.
   */
  async list(query: ListAuditQuery): Promise<Page<AuditEntry>> {
    return this.#audit.listAudit(query);
  }
}
