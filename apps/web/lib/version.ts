import paquete from "../package.json";

/**
 * Version desplegada que devuelve GET /api/health (11.1). Sale del
 * package.json de esta app y no de una constante aparte para que no puedan
 * separarse.
 *
 * Se re-exporta solo el campo `version` a proposito: importar el package.json
 * entero en el Route Handler meteria tambien la lista de dependencias en el
 * bundle del servidor, que no tiene por que estar ahi.
 */
export const VERSION: string = paquete.version;
