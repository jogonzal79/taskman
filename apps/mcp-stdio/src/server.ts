import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  contextoDeAgente,
  crearHerramientas,
  type OpcionesRegistro,
  type TaskManagerPort,
} from "@taskman/core";

/**
 * Monta el registro unico de herramientas del nucleo sobre un `McpServer`.
 *
 * Esto es TODO el adaptador. No valida, no resuelve nombres, no traduce
 * errores, y tampoco decide que herramientas hay: eso vive en
 * `packages/core/mcp` y es lo mismo para cualquier transporte. Si algun dia
 * aparece el Streamable HTTP de la 8.1, va a montar la misma lista con este
 * mismo bucle.
 *
 * UN SERVIDOR ATIENDE A UNA SOLA CLAVE. Los scopes entran al montar y lo que no
 * alcanzan no se registra, asi que el filtrado vive en la instancia: dos claves
 * con scopes distintos no pueden compartir un `McpServer`, y reusarlo entre
 * clientes le ofreceria a cada uno el catalogo del primero. Armar otro es
 * barato: 0,3 ms por servidor con las once (medido con el SDK 1.30.0), menos que
 * cualquier consulta que despues haga una llamada.
 */
export function crearServidorMcp(port: TaskManagerPort, opciones: OpcionesRegistro): McpServer {
  const server = new McpServer(
    { name: "taskman", version: "0.1.0" },
    {
      instructions:
        "Gestor de tareas Kanban. Los tableros, columnas y tareas se pueden referenciar por nombre " +
        "ademas de por id: no hace falta consultar antes de crear o mover. Si una referencia por nombre " +
        "es ambigua, la herramienta devuelve AMBIGUOUS_MATCH con los candidatos y hay que preguntarle al " +
        "usuario cual es, nunca elegir uno.",
    },
  );

  // El nombre del cliente se lee EN CADA llamada y no al montar: cuando esto
  // corre, el cliente todavia no se identifico —eso pasa en el initialize del
  // protocolo, despues del connect— asi que resolverlo ahora dejaria todos los
  // registros de auditoria con el actor desconocido.
  const contexto = (): ReturnType<typeof contextoDeAgente> =>
    contextoDeAgente(server.server.getClientVersion()?.name);

  // Llegan solo las de los scopes de la clave: las demas nunca se registran, y
  // para el SDK no existen en ningun lado, ni en el listado ni al invocarlas,
  // donde responde "Tool create_task not found". No es el "disabled" de la
  // politica de abajo, y la diferencia es a proposito (ver `crearHerramientas`).
  for (const herramienta of crearHerramientas(port, { ...opciones, contexto })) {
    const registrada = server.registerTool(
      herramienta.name,
      {
        title: herramienta.title,
        description: herramienta.description,
        inputSchema: herramienta.inputSchema,
        annotations: herramienta.annotations,
      },
      // El SDK ya valida contra `inputSchema` antes de llamar; el handler del
      // nucleo vuelve a validar para ser autocontenido (ver mcp/tool.ts). El
      // cast es solo de forma: `McpToolResult` es la forma de `CallToolResult`
      // que el nucleo declara sin importar el SDK.
      async (args: unknown): Promise<CallToolResult> =>
        (await herramienta.handler(args)) as CallToolResult,
    );

    // Una herramienta que el nucleo declara pero no ofrece (hoy, delete_task
    // con MCP_DESTRUCTIVE_POLICY=deny). Deshabilitada, el SDK la saca del
    // listado Y rechaza la llamada, que es el filtrado en los dos lados que
    // pide la 8.1. El precio es que el rechazo lo redacta el SDK ("Tool
    // delete_task disabled") y no llega al handler del nucleo, que tiene el
    // mensaje bueno: no hay forma de ocultarla del listado y conservar el
    // handler. Ese mensaje sigue siendo el que ve cualquier otro llamador de la
    // definicion, y "disabled" al menos no miente diciendo que no existe.
    if (herramienta.anunciada === false) {
      registrada.disable();
    }
  }

  return server;
}
