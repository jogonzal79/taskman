import type { ZodType } from "zod";

import type { Scope } from "../domain/api-key";

/**
 * La forma de una herramienta MCP, descrita como DATO.
 *
 * No importa el SDK de MCP a proposito: CLAUDE.md prohibe que `packages/core`
 * lo haga, y la 8.1 pide que el registro de herramientas sea uno solo,
 * compartido por los dos transportes. Las dos cosas se cumplen si el nucleo
 * declara herramientas y cada app las monta sobre su `McpServer`; el adaptador
 * queda reducido a un bucle de `registerTool` y no contiene ninguna regla.
 *
 * Los tipos de contenido replican la forma que espera el SDK (`{type:"text"}`),
 * que es parte del protocolo, no de la libreria.
 */

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  /** true cuando la llamada fallo. El agente lo ve como resultado, no como excepcion. */
  isError?: boolean;
}

/** Esquema de entrada: el "raw shape" de Zod que consume `registerTool`. */
export type EsquemaEntrada = Record<string, ZodType>;

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: EsquemaEntrada;
  /**
   * El scope de la 7.2 que exige la herramienta: la columna Scope de la 8.2
   * convertida en dato, en vez de vivir solo en el documento.
   *
   * OBLIGATORIO y sin valor por defecto, por lo mismo que el scope de `conAuth`
   * en el borde REST: una herramienta nueva que no lo declare no compila, asi que
   * la forma de dejar una abierta por descuido no existe. Falla cerrado.
   *
   * En el vocabulario del DOMINIO (`READ`, `WRITE`, `DELETE`) y no en el de la
   * 8.2, que lo escribe en minuscula como el borde HTTP. Es el mismo tipo que
   * `ClaveAutenticada.scopes`, asi que compararlos no necesita traduccion; la de
   * minuscula a mayuscula es del borde (`apps/web/lib/auth.ts`).
   *
   * No es un campo del protocolo y ningun transporte lo envia: es lo que necesita
   * un transporte que conozca la clave de quien llama para decidir que
   * herramientas ofrecerle (8.1). Tampoco depende de MCP_DESTRUCTIVE_POLICY: el
   * scope dice que necesita la clave, la politica dice que permite el servidor.
   */
  scope: Scope;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * Si la herramienta se ANUNCIA en el listado. Ausente es `true`.
   *
   * No es un campo del protocolo: es como el nucleo le dice al transporte que
   * una herramienta existe pero no se ofrece. Lo pide la 8.1 —"el filtrado
   * ocurre en el listado de herramientas, no solo en la ejecucion, para que el
   * agente no planifique acciones que no puede completar"— y hoy lo usa
   * MCP_DESTRUCTIVE_POLICY=deny; cuando lleguen los scopes de la 7.2 al
   * transporte HTTP, un cliente sin scope `delete` va a apagarla igual.
   *
   * La definicion no se omite del registro: sigue existiendo, con su handler,
   * que responde por que no se puede. Omitirla dejaria al llamador con un
   * "herramienta desconocida", que no distingue una politica de un error.
   */
  anunciada?: boolean;
  /**
   * Recibe los argumentos SIN validar y los valida contra `inputSchema`.
   *
   * El SDK tambien valida antes de llamar, asi que en produccion la segunda
   * pasada no rechaza nada. Se hace igual para que la definicion sea
   * autocontenida: un `HttpPort` o una prueba pueden invocar el handler
   * directamente sin reimplementar la validacion ni la traduccion de errores.
   */
  handler(args: unknown): Promise<McpToolResult>;
}
