import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { BoardDetail } from "../../domain/types.js";
import { cargarTablero, resolverColumnaDelTablero, resolverTareaDelTablero } from "../lookup.js";
import type { TaskManagerPort } from "../port.js";
import { esUuid } from "../resolve.js";
import { definirHandler, respuesta } from "../respuesta.js";
import type { McpToolDefinition } from "../tool.js";
import { campoBoard, campoColumn, campoPosition, cuentaTareas, tareaJson } from "./campos.js";

const shape = {
  task: z
    .string()
    .describe(
      "Tarea a mover, por id (UUID) o por titulo exacto sin distinguir mayusculas. " +
        "Si el titulo coincide con varias tareas del tablero, la herramienta responde AMBIGUOUS_MATCH con los candidatos, sus ids y su columna, y no elige por vos.",
    ),
  board: campoBoard
    .optional()
    .describe(
      "Tablero donde buscar la tarea, por id o por nombre. OBLIGATORIO si `task` es un titulo: la busqueda por titulo nunca es global. " +
        "Innecesario si `task` ya es un id.",
    ),
  to_column: campoColumn.describe(
    "Columna destino, por id, key (TODO, IN_PROGRESS, DONE) o nombre. Tiene que ser del mismo tablero que la tarea.",
  ),
  position: campoPosition,
};

/**
 * Resuelve tarea y tablero a la vez, porque una cosa depende de la otra.
 *
 * Con `board` el ambito es ese tablero. Sin `board`, `task` tiene que ser un id
 * y el tablero sale de la propia tarea: hace falta igual, porque `to_column` se
 * resuelve por nombre o key CONTRA las columnas del tablero, y sin cargarlas la
 * resolucion de columnas dejaria de ser la misma en los dos caminos.
 */
async function ubicar(
  port: TaskManagerPort,
  referenciaTarea: string,
  referenciaTablero: string | undefined,
): Promise<{ tablero: BoardDetail; taskId: string }> {
  if (referenciaTablero !== undefined) {
    const tablero = await cargarTablero(port, referenciaTablero);
    return { tablero, taskId: await resolverTareaDelTablero(port, tablero, referenciaTarea) };
  }

  if (!esUuid(referenciaTarea)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Falta `board`: un titulo solo se resuelve dentro de un tablero.",
      {
        details: { field: "board", task: referenciaTarea },
        hint: "Volve a llamar indicando board con el nombre o el id del tablero, o pasa el id de la tarea en task.",
      },
    );
  }

  const tarea = await port.getTask(referenciaTarea.trim());
  return { tablero: await port.getBoard(tarea.boardId), taskId: tarea.id };
}

export function definirMoveTask(port: TaskManagerPort): McpToolDefinition {
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
    handler: definirHandler("move_task", shape, async (args) => {
      const { tablero, taskId } = await ubicar(port, args.task, args.board);
      const destino = resolverColumnaDelTablero(tablero, args.to_column);

      const resultado = await port.moveTask(taskId, {
        columnId: destino.id,
        position: args.position,
      });

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
