import { leerNivelLog } from "@taskman/core";

/**
 * Validacion de entorno al arrancar (11.2): una variable ausente DEBE impedir
 * el arranque del proceso con un mensaje explicito, no producir un fallo
 * posterior en tiempo de ejecucion.
 *
 * `register()` corre una sola vez cuando Next levanta el servidor, antes de
 * atender la primera peticion. Es el unico punto de la App Router equivalente a
 * las comprobaciones que hace apps/mcp-stdio en su entrypoint.
 *
 * Esto NO es todavia el esquema Zod completo de la 11.2: hoy solo cubre
 * DATABASE_URL, que es la unica variable que este paso necesita.
 */
export function register(): void {
  // Tambien corre en el runtime edge, donde no hay base ni process.exit.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") {
    return;
  }

  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.trim() === "") {
    process.stderr.write(
      "[taskman-web] Falta DATABASE_URL. Copia .env.example a .env en la raiz del repo.\n",
    );
    process.exit(1);
  }

  /**
   * RATE_LIMIT_ENABLED (11.2). Es OPCIONAL —ausente, el limite de la 7.3 queda
   * encendido— pero un valor que no sea true o false SI impide el arranque, que
   * es lo que pide la 11.2 para una variable invalida.
   *
   * El motivo de ser estricto aca y no tolerante: el limite falla cerrado, asi
   * que `RATE_LIMIT_ENABLED=flase` lo deja ENCENDIDO. Quien escribio eso queria
   * apagarlo, y sin esta comprobacion se enteraria por los 429 de un cliente en
   * produccion. Al arranque se entera en la primera linea del log.
   */
  const limite = process.env["RATE_LIMIT_ENABLED"]?.trim().toLowerCase();
  if (limite !== undefined && limite !== "" && limite !== "true" && limite !== "false") {
    process.stderr.write(
      `[taskman-web] RATE_LIMIT_ENABLED tiene que ser "true" o "false", y es "${limite}".\n`,
    );
    process.exit(1);
  }

  /**
   * LOG_LEVEL (11.2). El log por peticion de la 11.1 lo lee PEREZOSAMENTE —en la
   * primera linea que escribe, para no romper el "Collecting page data" de
   * `next build`— y eso, solo, dejaria que un valor invalido apareciera como un
   * 500 en la primera peticion: exactamente el "fallo posterior en tiempo de
   * ejecucion" que la 11.2 prohibe. Comprobarlo aca cierra ese hueco sin quitarle
   * la pereza al logger: el mismo validador, corrido al arrancar.
   */
  try {
    leerNivelLog(process.env["LOG_LEVEL"]);
  } catch (error: unknown) {
    process.stderr.write(`[taskman-web] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
