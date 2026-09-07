import { ubicarTarea } from "../lookup.js";
import type { EntornoMcp } from "../llamada.js";
import type { TaskManagerPort } from "../port.js";
import { definirHandler, respuesta } from "../respuesta.js";
import { fechaIso } from "../respuesta.js";
import type { McpToolDefinition } from "../tool.js";
import { campoBoardDeTarea, campoTask, columnaJson, tableroJson, tareaJson } from "./campos.js";

const shape = {
  task: campoTask("a consultar"),
  board: campoBoardDeTarea,
};

export function definirGetTask(port: TaskManagerPort, entorno: EntornoMcp): McpToolDefinition {
  return {
    name: "get_task",
    title: "Consultar tarea",
    description:
      "Devuelve una tarea con todos sus campos y su ubicacion: tablero, columna y posicion. " +
      "Sirve para leer la descripcion completa de una tarea que list_tasks solo resume, y para confirmar el estado de una antes de actuar sobre ella.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "get_task", shape, async (args, llamada) => {
      const { tablero, taskId } = await ubicarTarea(port, args.task, args.board, llamada);
      const tarea = await port.getTask(taskId);
      const columna = tablero.columns.find((candidata) => candidata.id === tarea.columnId);

      const vence = fechaIso(tarea.dueDate);
      const lineas = [
        `"${tarea.title}"`,
        `  ${tablero.name} / ${columna?.key ?? tarea.columnId}  (posicion ${tarea.position})`,
        `  Prioridad ${tarea.priority}${vence === null ? "" : `  vence ${vence}`}`,
      ];
      lineas.push(
        tarea.description === null ? "  Sin descripcion." : `  ${tarea.description}`,
      );

      return respuesta(lineas, {
        task: tareaJson(tarea, columna?.key ?? null),
        board: tableroJson(tablero),
        column: columna === undefined ? null : columnaJson(columna),
      });
    }),
  };
}
