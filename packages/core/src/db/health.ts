import { prisma, type PrismaClient } from "@taskman/db";

/**
 * Sonda de conectividad para GET /api/health (11.1).
 *
 * Vive en el nucleo y no en el adaptador por la regla de dependencias de la
 * 3.2: ningun adaptador importa Prisma. El Route Handler solo llama a esta
 * funcion y traduce el resultado a su protocolo.
 *
 * El plazo tambien vive aca, por el mismo motivo: quien conoce el driver es el
 * nucleo. Sin plazo la sonda hereda el del pool de `pg`, que ante una base
 * caida puede tardar bastante mas de lo que tiene sentido esperar en un health
 * check, y el endpoint que deberia responder "degraded" en milisegundos se
 * queda colgado.
 */

const TIMEOUT_POR_DEFECTO_MS = 2000;

/**
 * `cliente` es el mecanismo de inyeccion del repo (los repositorios reciben su
 * `TransactionRunner`), pero va al final y con el singleton por defecto para
 * que la funcion sea invocable sin argumentos. Eso es lo que permite que
 * `apps/web` no dependa de `@taskman/db`: si el cliente fuera obligatorio, el
 * adaptador tendria que construirlo, que es exactamente lo que la 3.2 prohibe.
 *
 * No usa `TransactionRunner`: una sonda no necesita ni transaccion ni la
 * politica de reintentos. Es una lectura suelta, el mismo caso para el que los
 * repositorios usan `runner.prisma` directamente.
 */
export async function comprobarConexion(
  timeoutMs: number = TIMEOUT_POR_DEFECTO_MS,
  cliente: PrismaClient = prisma,
): Promise<void> {
  // Literal, sin interpolacion: no hay parametro que bindear ni nada que
  // escapar. La plantilla etiquetada de Prisma la manda tal cual.
  const consulta = cliente.$queryRaw`SELECT 1`;

  // Si gana el plazo, la consulta sigue viva y puede rechazar despues de que
  // nadie la espere.
  //
  // Este `catch` es un SEGURO, no una necesidad, y conviene saber cual es la
  // diferencia: `Promise.race` se suscribe a TODAS sus promesas, asi que el
  // rechazo tardio de la perdedora ya tiene manejador y NO dispara
  // `unhandledRejection`. Medido: una promesa que nadie observo si lo dispara; la
  // perdedora de un race, no. El comentario que habia aca afirmaba lo contrario
  // —que sin el catch el proceso se cae— y eso es lo que justificaba una linea que
  // ninguna prueba puede ejercitar (ver `packages/core/test/health.test.ts`, que
  // anota los dos intentos).
  //
  // Se conserva porque deja de ser cierto en cuanto el `race` de abajo se
  // reemplace por cualquier otra espera que no se suscriba a las dos.
  consulta.catch(() => {});

  let temporizador: ReturnType<typeof setTimeout> | undefined;
  const vencimiento = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => {
      rechazar(new Error(`La sonda a la base no respondio en ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([consulta, vencimiento]);
  } finally {
    clearTimeout(temporizador);
  }
}
