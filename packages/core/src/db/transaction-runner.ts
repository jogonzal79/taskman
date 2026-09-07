import { Prisma, type PrismaClient } from "@taskman/db";

import { isRetryableConflict } from "./db-error.js";

/**
 * Corre trabajo en UNA transaccion interactiva con aislamiento REPEATABLE READ
 * y la politica de reintentos del proyecto.
 *
 * Vive aparte de los repositorios porque las tres familias de operaciones
 * (tareas, columnas, tableros) comparten exactamente las mismas garantias, y
 * duplicar el bucle de reintentos seria la forma mas facil de que se separen.
 */
export class TransactionRunner {
  readonly #prisma: PrismaClient;
  readonly #maxRetries: number;

  constructor(prisma: PrismaClient, options: { maxRetries?: number } = {}) {
    this.#prisma = prisma;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  /** Acceso directo para lecturas sueltas, que no necesitan transaccion. */
  get prisma(): PrismaClient {
    return this.#prisma;
  }

  /**
   * Reintenta hasta dos veces ante contencion legitima: 40001 y la violacion de
   * las UNIQUE diferidas de orden. Ver `isRetryableConflict`, que explica por
   * que 40P01 queda afuera. Cualquier otro error, incluidos los de dominio,
   * sube sin tocar.
   */
  async run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    let ultimoFallo: unknown;

    for (let intento = 0; intento <= this.#maxRetries; intento += 1) {
      try {
        return await this.#prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 15_000,
          maxWait: 15_000,
        });
      } catch (error: unknown) {
        if (!isRetryableConflict(error)) {
          throw error;
        }
        ultimoFallo = error;
      }
    }

    throw ultimoFallo;
  }
}
