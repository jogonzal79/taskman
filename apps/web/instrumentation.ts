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
}
