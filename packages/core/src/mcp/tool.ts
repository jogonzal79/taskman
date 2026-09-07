import type { ZodType } from "zod";

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
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
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
