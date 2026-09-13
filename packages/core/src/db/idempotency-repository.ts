import { Prisma, type PrismaClient } from "@taskman/db";

import type { TransactionRunner } from "./transaction-runner.js";

/**
 * La fila fisica de `idempotency_record` (4.1 / 6.5): como se escribe y como se
 * lee.
 *
 * LA ESCRITURA NO TIENE REPOSITORIO, por lo mismo que la de `audit_log`: un
 * registro de idempotencia NUNCA se escribe por su cuenta. La 6.5 pide guardar
 * clave, hash, estado y cuerpo "en la misma transaccion" que la operacion, asi
 * que la fila se inserta con el `tx` de esa operacion. Si la operacion falla no
 * queda una clave quemada sin nada que devolver, y si falla el registro la
 * operacion se revierte y la clave sigue libre. Darle transaccion propia haria
 * posible justamente lo contrario.
 *
 * `IdempotencyRepository`, mas abajo, es SOLO DE LECTURA y no toca esa regla:
 * la consulta previa de la 6.5 no necesita transaccion —no hay nada que
 * revertir— y no expone ningun camino de escritura.
 */
export interface IdempotencyRow {
  /** El valor de la cabecera `Idempotency-Key`, tal cual lo mando el cliente. */
  key: string;
  /**
   * El cliente que la mando: el prefijo publico de su API key. Es la segunda
   * mitad de la PK compuesta, el desvio declarado de la 4.1 que evita que dos
   * claves de API que elijan el mismo valor de cabecera compartan fila.
   */
  clientId: string;
  /** SHA-256 en hexadecimal minusculo. La base lo verifica con un CHECK. */
  requestHash: string;
  statusCode: number;
  /** El cuerpo que se devolvio, como JSON. */
  responseBody: unknown;
}

/** La fila leida. `createdAt` es lo que usara la purga diaria de la 6.5. */
export interface IdempotencyRecord extends IdempotencyRow {
  createdAt: Date;
}

/**
 * Lo UNICO que una transaccion en curso le ofrece a un participante externo.
 *
 * Es una interfaz de un solo metodo a proposito, y ahi esta la decision: el
 * borde HTTP necesita escribir su fila DENTRO de la transaccion del nucleo,
 * pero darle la transaccion entera le daria tambien `insertAudit`, `insertBoard`
 * y el resto. El invariante de la 7.4 descansa en que el registro de auditoria
 * lo escriba `AuditService` con el evento que arma `domain/audit.ts`, y un
 * adaptador con `insertAudit` a mano podria saltearse las dos cosas sin que
 * nada lo impida. Con esta interfaz no puede: lo unico que alcanza es su propia
 * fila.
 */
export interface EscrituraIdempotente {
  insertIdempotency(row: IdempotencyRow): Promise<void>;
}

/**
 * `response_body` es JSONB NOT NULL, asi que aca no hay `DbNull` que elegir
 * como en `audit_log`: un registro sin cuerpo no existe.
 */
export async function insertIdempotencyRow(
  tx: Prisma.TransactionClient,
  row: IdempotencyRow,
): Promise<void> {
  await tx.idempotencyRecord.create({
    data: {
      key: row.key,
      clientId: row.clientId,
      requestHash: row.requestHash,
      statusCode: row.statusCode,
      responseBody: row.responseBody as Prisma.InputJsonValue,
    },
  });
}

/** La consulta previa de la 6.5. Solo lectura: ver el comentario de arriba. */
export class IdempotencyRepository {
  readonly #runner: TransactionRunner;

  constructor(runner: TransactionRunner) {
    this.#runner = runner;
  }

  get #prisma(): PrismaClient {
    return this.#runner.prisma;
  }

  async find(key: string, clientId: string): Promise<IdempotencyRecord | undefined> {
    const fila = await this.#prisma.idempotencyRecord.findUnique({
      where: { key_clientId: { key, clientId } },
    });

    if (fila === null) {
      return undefined;
    }

    return {
      key: fila.key,
      clientId: fila.clientId,
      requestHash: fila.requestHash,
      statusCode: fila.statusCode,
      responseBody: fila.responseBody,
      createdAt: fila.createdAt,
    };
  }
}
