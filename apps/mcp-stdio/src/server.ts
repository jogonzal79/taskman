import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  contextoDeAgente,
  crearHerramientas,
  IDENTIDAD_SERVIDOR_MCP,
  INSTRUCCIONES_MCP,
  montarHerramientas,
  type OpcionesRegistro,
  type TaskManagerPort,
} from "@taskman/core";

/**
 * Monta el registro unico de herramientas del nucleo sobre un `McpServer`.
 *
 * Esto es TODO el adaptador stdio. No valida, no resuelve nombres, no traduce
 * errores, y tampoco decide que herramientas hay ni como se registran: eso vive
 * en `packages/core/mcp` (`crearHerramientas` y `montarHerramientas`) y es lo
 * mismo que monta /mcp en `apps/web`. Lo unico propio de este transporte es de
 * donde sale el nombre del actor.
 *
 * UN SERVIDOR ATIENDE A UNA SOLA CLAVE. Los scopes entran al montar y lo que no
 * alcanzan no se registra, asi que el filtrado vive en la instancia: dos claves
 * con scopes distintos no pueden compartir un `McpServer`, y reusarlo entre
 * clientes le ofreceria a cada uno el catalogo del primero. Armar otro es
 * barato: 0,3 ms por servidor con las once (medido con el SDK 1.30.0), menos que
 * cualquier consulta que despues haga una llamada.
 */
export function crearServidorMcp(port: TaskManagerPort, opciones: OpcionesRegistro): McpServer {
  const server = new McpServer(IDENTIDAD_SERVIDOR_MCP, { instructions: INSTRUCCIONES_MCP });

  // El nombre del cliente se lee EN CADA llamada y no al montar: cuando esto
  // corre, el cliente todavia no se identifico —eso pasa en el initialize del
  // protocolo, despues del connect— asi que resolverlo ahora dejaria todos los
  // registros de auditoria con el actor desconocido. Por stdio hay UNA sesion
  // larga y el initialize se ve; /mcp no tiene sesion y toma el nombre de la
  // clave (ver `apps/web/lib/mcp.ts`).
  const contexto = (): ReturnType<typeof contextoDeAgente> =>
    contextoDeAgente(server.server.getClientVersion()?.name);

  montarHerramientas(server, crearHerramientas(port, { ...opciones, contexto }));

  return server;
}
