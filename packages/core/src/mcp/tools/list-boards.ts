import { z } from "zod";

import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import { tableroJson } from "./campos";

const shape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe(
      "Maximo de tableros a devolver, entre 1 y 100. Si quedan mas, la respuesta lo indica con has_more.",
    ),
};

/** "1 tablero" / "3 tableros". */
function cuenta(cantidad: number): string {
  return cantidad === 1 ? "1 tablero" : `${cantidad} tableros`;
}

export function definirListBoards(port: TaskManagerPort, entorno: EntornoMcp): McpToolDefinition {
  return {
    name: "list_boards",
    title: "Listar tableros",
    description:
      "Lista los tableros existentes con su id y su nombre. " +
      "Es la herramienta con la que se descubre que tableros hay cuando el usuario no nombra ninguno, o cuando un nombre resulto ambiguo. " +
      "No devuelve columnas ni tareas: para el detalle de uno esta get_board, y para su contenido, list_tasks.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "list_boards", shape, async (args) => {
      const pagina = await port.listBoards({ limit: args.limit });

      const lineas = [`${cuenta(pagina.items.length)}.`];
      for (const tablero of pagina.items) {
        const detalle = tablero.description === null ? "" : `  ${tablero.description}`;
        lineas.push(`  "${tablero.name}"${detalle}`);
      }
      if (pagina.nextCursor !== null) {
        lineas.push(`  Hay mas tableros de los que entran en limit=${args.limit}.`);
      }

      return respuesta(lineas, {
        boards: pagina.items.map(tableroJson),
        count: pagina.items.length,
        has_more: pagina.nextCursor !== null,
      });
    }),
  };
}
