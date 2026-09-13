import { describe, expect, it } from "vitest";

import { comprobarConexion } from "../src/index";

/**
 * La sonda de conectividad de la 11.1, que es lo unico que hay detras de
 * GET /api/health.
 *
 * No tenia prueba en ningun nivel. La del 200 la ejercita contra PostgreSQL real
 * desde la suite de `apps/web`, pero eso no cubre lo que esta funcion tiene de
 * propio: el PLAZO —que existe para que una base caida no cuelgue el endpoint que
 * deberia avisar de que esta caida— y que un fallo del driver se propague en vez
 * de quedar tragado.
 *
 * Los dos casos de fallo van con un cliente FALSO y no con una base rota: asi son
 * deterministas y no dependen de tumbar el contenedor que comparte toda la suite.
 * El tipo sale de la firma con `Parameters<...>` para no importar `PrismaClient`
 * solo para castear.
 */
type Cliente = Parameters<typeof comprobarConexion>[1];

function clienteQueNoResponde(): Cliente {
  // La consulta nunca se resuelve: gana el plazo siempre, sin carrera.
  return { $queryRaw: () => new Promise(() => {}) } as unknown as Cliente;
}

function clienteQueFalla(error: Error): Cliente {
  return { $queryRaw: () => Promise.reject(error) } as unknown as Cliente;
}

describe("comprobarConexion", () => {
  it("resuelve contra la base de desarrollo", async () => {
    await expect(comprobarConexion()).resolves.toBeUndefined();
  });

  it("rechaza al vencer el plazo, y no espera al driver", async () => {
    const inicio = Date.now();

    await expect(comprobarConexion(20, clienteQueNoResponde())).rejects.toThrow(
      /no respondio en 20 ms/,
    );

    // Lo que importa del plazo no es el mensaje sino que CORTE: si no cortara,
    // esta promesa no se habria asentado nunca y el test moriria por timeout.
    // El margen es generoso a proposito; lo que se afirma es el orden de
    // magnitud, no el reloj.
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it("propaga el fallo del driver en vez de tragarlo", async () => {
    const fallo = new Error("Can't reach database server at 127.0.0.1:5432");

    await expect(comprobarConexion(2000, clienteQueFalla(fallo))).rejects.toBe(fallo);
  });

  /**
   * NO hay una cuarta prueba para el `consulta.catch(() => {})` de la sonda, y la
   * ausencia es el resultado de intentarla.
   *
   * Ese catch dice proteger de una unhandled rejection cuando el plazo gana y la
   * consulta rechaza despues. Escribi la prueba dos veces: la primera terminaba
   * en un `expect(true).toBe(true)` y pasaba con la guarda y sin ella, o sea que
   * no probaba nada; la segunda escuchaba `process.on("unhandledRejection")` y
   * TAMBIEN pasaba con la guarda quitada. El motivo esta medido aparte:
   * `Promise.race` se suscribe a TODAS sus promesas, asi que el rechazo tardio
   * del perdedor ya tiene un manejador y nunca queda sin manejar (una promesa que
   * nadie observo si dispara el evento; la perdedora de un race, no).
   *
   * O sea que no hay nada que detectar: con race, esa guarda no cambia el
   * comportamiento observable. Se conserva igual —deja de ser cierta en cuanto el
   * race se reemplace— y el comentario de `health.ts` ya lo dice asi.
   */
});
