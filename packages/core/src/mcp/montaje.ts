import type { EsquemaEntrada, McpToolDefinition, McpToolResult } from "./tool";

/**
 * EL MONTAJE de las herramientas sobre un servidor MCP, escrito UNA vez para los
 * dos transportes de la 8.1.
 *
 * Vivia en `apps/mcp-stdio/src/server.ts`, y `apps/web` no puede importar de otra
 * app (3.3). Duplicarlo en /mcp era la otra salida, y es exactamente la que la
 * ADR-003 descarta: el bucle no es un detalle del transporte, es la traduccion de
 * la definicion al protocolo —que campos se anuncian y que herramienta se
 * deshabilita— y dos copias de eso se desincronizan igual que dos copias de las
 * once herramientas. Un paquete nuevo tampoco: la 3.3 no tiene uno para esto.
 *
 * EL NUCLEO SIGUE SIN IMPORTAR EL SDK. `ServidorDeHerramientas` describe la FORMA
 * del `McpServer` que el montaje usa —`registerTool` y el `disable` de lo que
 * devuelve— y el del SDK encaja por tipado estructural, sin cast (comprobado con
 * tsc; ver la nota de `McpToolResult` en `tool.ts`). Si el SDK cambia esa firma,
 * lo que se rompe es el typecheck de la app que lo monta, que es un fallo ruidoso.
 */

/** Como se presenta el servidor en el initialize, igual en los dos transportes. */
export const IDENTIDAD_SERVIDOR_MCP = { name: "taskman", version: "0.1.0" } as const;

/**
 * Las instrucciones que el cliente le pasa al modelo. Son parte de lo que el
 * agente ve, asi que tampoco pueden diferir entre stdio y /mcp.
 */
export const INSTRUCCIONES_MCP =
  "Gestor de tareas Kanban. Los tableros, columnas y tareas se pueden referenciar por nombre " +
  "ademas de por id: no hace falta consultar antes de crear o mover. Si una referencia por nombre " +
  "es ambigua, la herramienta devuelve AMBIGUOUS_MATCH con los candidatos y hay que preguntarle al " +
  "usuario cual es, nunca elegir uno.";

/** Lo unico del `McpServer` del SDK que el montaje necesita. */
export interface ServidorDeHerramientas {
  registerTool(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: EsquemaEntrada;
      annotations: McpToolDefinition["annotations"];
    },
    cb: (args: unknown) => Promise<McpToolResult>,
  ): { disable(): void };
}

/**
 * Registra en `servidor` las herramientas que devolvio `crearHerramientas`.
 *
 * No valida, no resuelve nombres, no traduce errores y no decide que herramientas
 * hay: eso ya paso en `crearHerramientas`, con los scopes de la clave y la
 * politica. Lo que llega es la lista filtrada, y lo que no llega no se registra:
 * para el SDK no existe ni en el listado ni al invocarla.
 */
export function montarHerramientas(
  servidor: ServidorDeHerramientas,
  herramientas: readonly McpToolDefinition[],
): void {
  for (const herramienta of herramientas) {
    const registrada = servidor.registerTool(
      herramienta.name,
      {
        title: herramienta.title,
        description: herramienta.description,
        inputSchema: herramienta.inputSchema,
        annotations: herramienta.annotations,
      },
      // El SDK ya valida contra `inputSchema` antes de llamar; el handler del
      // nucleo vuelve a validar para ser autocontenido (ver `tool.ts`).
      (args) => herramienta.handler(args),
    );

    // Una herramienta que el nucleo declara pero no ofrece (hoy, delete_task
    // con MCP_DESTRUCTIVE_POLICY=deny). Deshabilitada, el SDK la saca del
    // listado Y rechaza la llamada, que es el filtrado en los dos lados que
    // pide la 8.1. El precio es que el rechazo lo redacta el SDK ("Tool
    // delete_task disabled") y no llega al handler del nucleo, que tiene el
    // mensaje bueno: no hay forma de ocultarla del listado y conservar el
    // handler. "disabled" al menos no miente diciendo que no existe.
    if (herramienta.anunciada === false) {
      registrada.disable();
    }
  }
}
