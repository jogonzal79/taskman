import { LOGGER_NULO } from "@taskman/core";
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
});
