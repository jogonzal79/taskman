import { setTimeout as esperar } from "node:timers/promises";

import { Prisma, type PrismaClient } from "@taskman/db";

import { isRetryableConflict } from "./db-error";

/**
 * Espera entre reintentos: exponencial con jitter completo.
 *
 * QUE RESUELVE. El caso de dos transacciones que chocan UNA vez: sin jitter las
 * dos reintentan sincronizadas y el reintento hereda la misma carrera que lo
 * causo. Con jitter completo (uniforme en [0, techo), no un retraso fijo ni
 * fijo-mas-ruido) se desfasan y una encuentra la fila libre.
 *
 * QUE NO RESUELVE, y conviene decirlo porque es facil leerlo al reves: esto NO
 * arregla el fallo intermitente de varios create de columna concurrentes que
 * documenta CLAUDE.md. Medido: con estos valores ese caso sigue fallando 3 de
 * 15 veces, igual que sin backoff. Ahi hay que saltear una cadena de
 * invalidacion que dura varias transacciones, y dispersar unos milisegundos
 * dentro de la ventana no sirve. Subir estos numeros hasta taparlo (con 40 ms
 * de base el caso pasa 10 de 10) seria tunear un parametro global para una
 * contencion que no es nuestro escenario.
 *
 * Los numeros salen de cuanto dura una transaccion aca: la suite de integracion
 * de packages/core corre mas de cien casos contra PostgreSQL real en ~11 s, asi
 * que una transaccion esta en el orden de unos pocos milisegundos. Con el tope
 * de dos reintentos que fija CLAUDE.md, la espera acumulada en el peor caso es
 * 5 + 10 = 15 ms, y ~7 ms en promedio: despreciable frente a lo que ya cuesta
 * la operacion. El techo de 50 ms nunca se alcanza con dos reintentos; esta
 * para que subir el presupuesto algun dia no genere esperas largas por
 * descuido.
 */
const BACKOFF_BASE_MS = 5;
const BACKOFF_TECHO_MS = 50;

function esperaAntesDelSiguienteIntento(intento: number): number {
  const techo = Math.min(BACKOFF_BASE_MS * 2 ** intento, BACKOFF_TECHO_MS);
  return Math.random() * techo;
}

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
   *
   * Entre intento e intento espera con jitter: ver
   * `esperaAntesDelSiguienteIntento`. Cambia CUANDO se dispara cada reintento,
   * no cuantos son.
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

      // Solo si queda otro intento: no tiene sentido esperar para fallar.
      if (intento < this.#maxRetries) {
        await esperar(esperaAntesDelSiguienteIntento(intento));
      }
    }

    throw ultimoFallo;
  }
}
