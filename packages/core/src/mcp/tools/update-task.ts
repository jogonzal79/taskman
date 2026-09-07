import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { UpdateTaskInput } from "../../domain/types.js";
import { ubicarTarea } from "../lookup.js";
import type { EntornoMcp } from "../llamada.js";
import type { TaskManagerPort } from "../port.js";
import { definirHandler, respuesta } from "../respuesta.js";
import type { McpToolDefinition } from "../tool.js";
import {
  aFecha,
  campoBoardDeTarea,
  campoTask,
  prioridad,
  tareaJson,
} from "./campos.js";

/**
 * Los campos que un agente va a intentar cambiar aca y que NO se cambian aca.
 *
 * Se declaran en el esquema en vez de omitirse. Omitirlos seria peor: el
 * validador descarta las claves que no conoce, asi que un `position` de mas
 * pasaria en silencio y la herramienta contestaria "actualizada" sin haber
 * movido nada. Declarados, el agente lee en la descripcion que existe otra
 * herramienta y, si igual los manda, obtiene un error que la nombra.
 */
const REDIRIGIDOS: Record<string, string> = {
  position: "Reordenar una tarea es move_task, no update_task.",
  column: "Cambiar una tarea de columna es move_task, no update_task.",
};

const shape = {
  task: campoTask("a actualizar"),
  board: campoBoardDeTarea,
  title: z
    .string()
    .optional()
    .describe(
      "Nuevo titulo. Maximo 200 caracteres y no puede quedar vacio tras recortar espacios. Omitido, el titulo no cambia.",
    ),
  description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Nueva descripcion. Omitida, la descripcion no cambia; null la borra. Reemplaza la anterior entera, no se agrega a ella.",
    ),
  priority: prioridad
    .optional()
    .describe("Nueva prioridad. Omitida, la prioridad no cambia."),
  due_date: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Nueva fecha limite en formato AAAA-MM-DD (solo fecha, sin hora ni zona horaria). Omitida, el vencimiento no cambia; null lo quita.",
    ),
  position: z
    .union([z.number().int().min(0), z.literal("end")])
    .optional()
    .describe(
      "NO se cambia con esta herramienta: reordenar una tarea es move_task. Si lo mandas, la llamada falla y te dice con que llamar.",
    ),
  column: z
    .string()
    .optional()
    .describe(
      "NO se cambia con esta herramienta: mover una tarea de columna es move_task. Si lo mandas, la llamada falla y te dice con que llamar.",
    ),
};

/** Los campos que este patch SI modifica. Vacio significa que no hay que escribir. */
const MODIFICABLES = ["title", "description", "priority", "due_date"] as const;

export function definirUpdateTask(
  port: TaskManagerPort,
  entorno: EntornoMcp,
): McpToolDefinition {
  return {
    name: "update_task",
    title: "Actualizar tarea",
    description:
      "Cambia el titulo, la descripcion, la prioridad o el vencimiento de una tarea. " +
      "Es un patch parcial: solo los campos que mandes cambian, y null en description o due_date los borra. " +
      "No cambia ni la columna ni la posicion: para eso esta move_task.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Repetir el mismo patch deja el mismo estado final.
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "update_task", shape, async (args, llamada) => {
      const entrada = args as Record<string, unknown>;

      const redirigidos = Object.keys(REDIRIGIDOS).filter(
        (campo) => entrada[campo] !== undefined,
      );
      if (redirigidos.length > 0) {
        throw new DomainError(
          "VALIDATION_ERROR",
          `update_task no cambia ${redirigidos.join(" ni ")}.`,
          {
            details: {
              fields: redirigidos.map((campo) => ({
                field: campo,
                reason: REDIRIGIDOS[campo] ?? "",
              })),
            },
            // El hint es la parte accionable: la llamada exacta que si hace lo
            // que el agente queria, no solo el nombre de la otra herramienta.
            hint: `Llama a move_task con task=${JSON.stringify(args.task)}${
              args.board === undefined ? "" : `, board=${JSON.stringify(args.board)}`
            }, to_column=<columna destino> y position=<posicion>. Si ademas queres cambiar campos de la tarea, esta llamada sirve sin position ni column.`,
          },
        );
      }

      if (!MODIFICABLES.some((campo) => entrada[campo] !== undefined)) {
        throw new DomainError("VALIDATION_ERROR", "No indicaste ningun campo a modificar.", {
          details: { fields: MODIFICABLES.map((campo) => ({ field: campo, reason: "ausente" })) },
          hint: "Manda al menos uno de title, description, priority o due_date. Para mover o reordenar la tarea, usa move_task.",
        });
      }

      const { tablero, taskId } = await ubicarTarea(port, args.task, args.board, llamada);

      // `null` explicito borra, ausente deja como esta: son casos distintos y
      // el tipo del nucleo los distingue, asi que el borde no puede aplanarlos.
      const dueDate =
        args.due_date === undefined ? undefined : args.due_date === null ? null : aFecha(args.due_date);

      const patch: UpdateTaskInput = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(dueDate === undefined ? {} : { dueDate }),
      };

      const tarea = await port.updateTask(taskId, patch, llamada.ctx);
      const columna = tablero.columns.find((candidata) => candidata.id === tarea.columnId);

      return respuesta(
        [
          "Tarea actualizada.",
          `  "${tarea.title}"  ${tablero.name} / ${columna?.key ?? tarea.columnId}`,
          `  Cambiaron: ${MODIFICABLES.filter((campo) => entrada[campo] !== undefined).join(", ")}.`,
        ],
        { task: tareaJson(tarea, columna?.key ?? null) },
      );
    }),
  };
}
