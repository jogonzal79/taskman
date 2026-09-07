import { z } from "zod";

/**
 * La politica de operaciones destructivas de la 8.3.2, controlada por
 * MCP_DESTRUCTIVE_POLICY (11.2).
 *
 * Vive en el nucleo y no en la app porque decide DOS cosas que no pueden
 * separarse: si delete_task se anuncia en el listado y que hace cuando la
 * invocan. Si la app resolviera una y el registro la otra, un `deny` podria
 * quedar a medias: la herramienta oculta pero ejecutable, que es exactamente el
 * fallo que la 8.1 quiere evitar cuando pide que el filtrado ocurra en el
 * listado y no solo en la ejecucion.
 *
 * Lo que NO vive aca es leer `process.env`: eso es de cada app. El nucleo
 * recibe el valor crudo y dice si sirve.
 */

export const POLITICAS_DESTRUCTIVAS = ["confirm", "allow", "deny"] as const;

export type PoliticaDestructiva = (typeof POLITICAS_DESTRUCTIVAS)[number];

/** La 8.3.2 fija `confirm` como valor por defecto: sin configurar, se pregunta. */
export const POLITICA_DESTRUCTIVA_POR_DEFECTO: PoliticaDestructiva = "confirm";

const ESQUEMA = z.enum(POLITICAS_DESTRUCTIVAS);

/**
 * Valida el valor crudo de MCP_DESTRUCTIVE_POLICY.
 *
 * Ausente o vacia devuelve el valor por defecto; cualquier otra cosa LANZA, con
 * el mensaje ya redactado. La 11.2 exige que una variable invalida impida el
 * arranque con un mensaje explicito y no un fallo posterior: si esto devolviera
 * el valor por defecto ante un `MCP_DESTRUCTIVE_POLICy=denyy`, el usuario creeria
 * tener el borrado desactivado y lo tendria activo con confirmacion.
 *
 * Se normaliza el caso porque `deny` y `Deny` son la misma intencion escrita a
 * mano en un `.mcp.json`, y aceptar la segunda no puede convertir una politica
 * en otra. Un valor que no esta en la lista sigue siendo un error.
 */
export function leerPoliticaDestructiva(valor: string | undefined): PoliticaDestructiva {
  const bruto = (valor ?? "").trim().toLowerCase();
  if (bruto === "") {
    return POLITICA_DESTRUCTIVA_POR_DEFECTO;
  }

  const validado = ESQUEMA.safeParse(bruto);
  if (!validado.success) {
    throw new Error(
      `MCP_DESTRUCTIVE_POLICY="${valor ?? ""}" no es un valor valido. ` +
        `Los valores posibles son: ${POLITICAS_DESTRUCTIVAS.join(", ")}. ` +
        `Sin definir equivale a "${POLITICA_DESTRUCTIVA_POR_DEFECTO}".`,
    );
  }

  return validado.data;
}
