import { cargarTablero, tareasDelTablero } from "../lookup";
import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import { campoBoard, columnaJson, cuentaTareas, tableroJson } from "./campos";

const shape = {
  board: campoBoard,
};

export function definirGetBoard(port: TaskManagerPort, entorno: EntornoMcp): McpToolDefinition {
  return {
    name: "get_board",
    title: "Consultar tablero",
    description:
      "Devuelve un tablero con sus columnas en orden, el id y la key de cada una, y cuantas tareas tiene cada columna. " +
      "Es lo que hace falta para encadenar create_task, move_task o list_tasks sobre ese tablero sin volver a resolver nada. " +
      "No devuelve las tareas: para verlas esta list_tasks.",
    inputSchema: shape,
    scope: "READ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "get_board", shape, async (args, llamada) => {
      const tablero = await cargarTablero(port, args.board, llamada);
      const tareas = await tareasDelTablero(port, tablero.id);

      const cuentaPorColumna = new Map(tablero.columns.map((columna) => [columna.id, 0]));
      for (const tarea of tareas) {
        cuentaPorColumna.set(tarea.columnId, (cuentaPorColumna.get(tarea.columnId) ?? 0) + 1);
      }

      const lineas = [
        `Tablero "${tablero.name}": ${tablero.columns.length} columnas, ${cuentaTareas(tareas.length)}.`,
      ];
      if (tablero.description !== null) {
        lineas.push(`  ${tablero.description}`);
      }
      for (const columna of tablero.columns) {
        lineas.push(`  ${columna.key}  "${columna.name}"  (${cuentaPorColumna.get(columna.id) ?? 0})`);
      }

      return respuesta(lineas, {
        board: tableroJson(tablero),
        columns: tablero.columns.map((columna) => ({
          ...columnaJson(columna),
          task_count: cuentaPorColumna.get(columna.id) ?? 0,
        })),
        task_count: tareas.length,
      });
    }),
  };
}
