import { beforeEach } from "vitest";

import { reiniciarCacheDeClaves } from "../src/index.js";

/**
 * Vacia el cache de claves de la 7.1 antes de cada prueba.
 *
 * Su estado esta anclado al PROCESO —tiene que estarlo, ver `api-key-cache.ts`—
 * asi que `truncateAll` no lo alcanza: sin esto, una clave que autentico en una
 * prueba seguiria autenticando en la siguiente aunque su fila ya no exista, y el
 * resultado dependeria del orden de los tests.
 *
 * Va en `setupFiles` y no en los helpers por lo mismo que en `apps/web`: asi no
 * depende de que un archivo nuevo se acuerde de importar nada.
 */
beforeEach(() => {
  reiniciarCacheDeClaves();
});
