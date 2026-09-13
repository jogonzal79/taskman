import { resolverColumnaDelTablero, ubicarTarea } from "../lookup";
import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import {
  campoBoardDeTarea,
  campoColumn,
  campoPosition,
  campoTask,
  cuentaTareas,
  tareaJson,
} from "./campos";

const shape = {
  task: campoTask("a mover"),
  board: campoBoardDeTarea,
  to_column: campoColumn.describe(
    "Columna destino, por id, key (TODO, IN_PROGRESS, DONE) o nombre. Tiene que ser del mismo tablero que la tarea.",
  ),
  position: campoPosition,
};

export function definirMoveTask(
  port: TaskManagerPort,
  entorno: EntornoMcp,
): McpToolDefinition {
  return {
    name: "move_task",
    title: "Mover tarea",
    description:
      "Mueve una tarea a otra columna del mismo tablero, o la reordena dentro de la suya. " +
      "Acepta la tarea y la columna por nombre, asi que 'move Revisar HU-25 a IN PROGRESS' es una sola llamada. " +
      "Devuelve el orden final completo de las columnas afectadas.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Repetir el mismo movimiento deja el mismo estado final.
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "move_task", shape, async (args, llamada) => {
      const { tablero, taskId } = await ubicarTarea(port, args.task, args.board, llamada);
      const destino = resolverColumnaDelTablero(tablero, args.to_column, llamada);

      const resultado = await port.moveTask(
        taskId,
        { columnId: destino.id, position: args.position },
        llamada.ctx,
      );

      const keyDe = new Map(tablero.columns.map((columna) => [columna.id, columna.key]));
      const origen = keyDe.get(resultado.fromColumnId) ?? resultado.fromColumnId;
      const ordenDestino =
        resultado.affectedColumns.find((columna) => columna.columnId === destino.id)?.taskOrder ??
        [];

      const lineas =
        resultado.fromColumnId === resultado.toColumnId
          ? [
              "Tarea reordenada.",
              `  "${resultado.task.title}"  ${destino.key}  (posicion ${resultado.task.position})`,
              `  ${destino.key} contiene ${cuentaTareas(ordenDestino.length)}.`,
            ]
          : [
              "Tarea movida.",
              `  "${resultado.task.title}"  ${origen} -> ${destino.key}  (posicion ${resultado.task.position})`,
              `  ${destino.key} contiene ahora ${cuentaTareas(ordenDestino.length)}.`,
            ];

      return respuesta(lineas, {
        task: tareaJson(resultado.task, destino.key),
        from_column: { id: resultado.fromColumnId, key: origen },
        to_column: { id: destino.id, key: destino.key },
        // El orden final completo de cada columna afectada (5.1): con esto el
        // agente conoce el estado resultante sin volver a listar.
        affected_columns: resultado.affectedColumns.map((columna) => ({
          column_id: columna.columnId,
          column_key: keyDe.get(columna.columnId) ?? null,
          task_order: columna.taskOrder,
        })),
      });
    }),
  };
}
