import { LOGGER_NULO, reiniciarCacheDeClaves } from "@taskman/core";
import { beforeEach } from "vitest";

import { fijarLogger } from "../lib/log.js";

/**
 * Calla el log de la 11.1 en TODA la suite.
 *
 * Va en `setupFiles` y no en `test/helpers.ts` por lo mismo que el interruptor
 * del limite de peticiones va en la configuracion: asi no depende de que un
 * archivo de prueba nuevo se acuerde de importar nada. Y va aca y no apagandolo
 * por nivel con LOG_LEVEL=error, porque los 500 y los contratos rotos SE PRUEBAN
 * —hay casos que los provocan a proposito— y a nivel error igual imprimirian: el
 * log quedaria en la salida de una suite verde, que es el ruido que hace que
 * nadie mire la salida.
 *
 * `LOGGER_NULO` es del nucleo, no un doble escrito aca: es el hueco que ya existe
 * para esto (`domain/logger.ts`).
 *
 * El `beforeEach` lo reinstala antes de cada prueba porque `test/log.test.ts` pone
 * el suyo para poder afirmar sobre las lineas; sin esto, la primera prueba que lo
 * reemplace dejaria el resto del archivo escribiendo de verdad.
 */
beforeEach(() => {
  fijarLogger(LOGGER_NULO);

  /**
   * Y vacia el cache de claves de la 7.1, por el mismo motivo y en el mismo
   * sitio: su estado esta anclado al PROCESO, no a la peticion ni al archivo, asi
   * que sin esto una prueba heredaria las claves que autentico la anterior.
   *
   * Sin eso la suite quedaria a merced del orden: `truncateAll` borra las filas
   * pero no el cache, asi que una clave emitida en una prueba seguiria
   * autenticando en la siguiente hasta 60 s despues. Hoy no colisiona porque cada
   * `emitirClave` genera un prefijo nuevo al azar, pero "hoy no colisiona" es
   * justo lo que no se quiere sostener a mano.
   */
  reiniciarCacheDeClaves();
});
