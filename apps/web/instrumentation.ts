import { validarEntorno } from "./lib/config.js";

/**
 * Validacion de entorno al arrancar (11.2): una variable ausente o invalida DEBE
 * impedir el arranque del proceso con un mensaje explicito, no producir un fallo
 * posterior en tiempo de ejecucion.
 *
 * `register()` corre una sola vez cuando Next levanta el servidor, antes de
 * atender la primera peticion. Es el unico punto de la App Router equivalente a
 * las comprobaciones que hace apps/mcp-stdio en su entrypoint.
 *
 * ARRANCAR NO ES IMPORTAR, y de eso depende que esto funcione: el esquema vive en
 * `lib/config.ts` y no lee `process.env` por su cuenta, asi que importarlo no
 * valida nada. El "Collecting page data" de `next build` importa cada modulo del
 * arbol sin ejecutar `register()`, y por eso el build sigue andando sin base y sin
 * pepper. Las tres comprobaciones sueltas que habia aca —DATABASE_URL,
 * RATE_LIMIT_ENABLED y LOG_LEVEL— estan ahora en el esquema; esta funcion solo lo
 * invoca y traduce el fallo a una salida del proceso.
 */
export function register(): void {
  // Tambien corre en el runtime edge, donde no hay base ni process.exit.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") {
    return;
  }

  try {
    validarEntorno(process.env);
  } catch (error: unknown) {
    process.stderr.write(
      `[taskman-web] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
