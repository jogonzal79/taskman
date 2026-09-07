import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { CreateTaskInput } from "../../domain/types.js";
import { cargarTablero, ordenDeColumna, resolverColumnaDelTablero } from "../lookup.js";
import type { TaskManagerPort } from "../port.js";
import { definirHandler, respuesta } from "../respuesta.js";
import type { McpToolDefinition } from "../tool.js";
import {
  campoBoard,
  campoColumn,
  campoPosition,
  cuentaTareas,
  prioridad,
  tareaJson,
} from "./campos.js";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const shape = {
  board: campoBoard,
  column: campoColumn.describe(
    `${campoColumn.description ?? ""} La tarea se crea en esta columna, que debe pertenecer al tablero indicado.`,
  ),
  title: z
    .string()
    .describe(
      "Titulo de la tarea, tal como lo diria el usuario. Maximo 200 caracteres y no puede quedar vacio tras recortar espacios. Es lo que despues permite referirse a la tarea por nombre.",
    ),
  description: z
    .string()
    .optional()
    .describe("Detalle libre de la tarea. Omitido, la tarea queda sin descripcion."),
  priority: prioridad
    .optional()
    .describe("Prioridad de la tarea. Omitida, se crea con MEDIUM."),
  due_date: z
    .string()
    .optional()
    .describe(
      "Fecha limite en formato AAAA-MM-DD (solo fecha, sin hora ni zona horaria). Omitida, la tarea no tiene vencimiento.",
    ),
  position: campoPosition.describe(
    "Posicion 0-based dentro de la columna, o 'end' (por defecto) para agregarla al final. Con un indice concreto las tareas siguientes se desplazan.",
  ),
};

/**
 * `due_date` llega como fecha sin hora y la columna es DATE: se ancla a
 * medianoche UTC para que no la corra la zona horaria del proceso. Sin la `Z`,
 * `new Date("2026-09-11")` y `new Date("2026-09-11T00:00")` dan dias distintos
 * segun donde corra el servidor.
 */
function aFecha(valor: string): Date {
  if (!FECHA.test(valor)) {
    throw new DomainError("VALIDATION_ERROR", `"${valor}" no es una fecha AAAA-MM-DD.`, {
      details: { field: "due_date", value: valor },
      hint: "Usa el formato AAAA-MM-DD, por ejemplo 2026-09-11.",
    });
  }

  const fecha = new Date(`${valor}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) {
    throw new DomainError("VALIDATION_ERROR", `"${valor}" no es una fecha existente.`, {
      details: { field: "due_date", value: valor },
      hint: "Revisa el mes y el dia: el formato es AAAA-MM-DD.",
    });
  }
  return fecha;
}

export function definirCreateTask(port: TaskManagerPort): McpToolDefinition {
  return {
    name: "create_task",
    title: "Crear tarea",
    description:
      "Crea una tarea en una columna de un tablero. Tablero y columna se pueden indicar por nombre o por key, " +
      "asi que no hace falta consultar el tablero antes: 'crea X en TODO del tablero QA' es una sola llamada. " +
      "Devuelve la tarea creada y el orden final de la columna.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Dos llamadas iguales crean dos tareas: no es idempotente y el agente
      // tiene que saberlo antes de reintentar por su cuenta.
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: definirHandler("create_task", shape, async (args) => {
      const tablero = await cargarTablero(port, args.board);
      const columna = resolverColumnaDelTablero(tablero, args.column);

      const input: CreateTaskInput = {
        boardId: tablero.id,
        columnId: columna.id,
        title: args.title,
        position: args.position,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.due_date === undefined ? {} : { dueDate: aFecha(args.due_date) }),
      };

      const tarea = await port.createTask(input);
      const orden = await ordenDeColumna(port, tablero.id, columna.id);

      return respuesta(
        [
          "Tarea creada.",
          `  "${tarea.title}"  ${tablero.name} / ${columna.key}  (posicion ${tarea.position})`,
          `  ${columna.key} contiene ahora ${cuentaTareas(orden.length)}.`,
        ],
        {
          task: tareaJson(tarea, columna.key),
          column: { id: columna.id, key: columna.key, task_order: orden },
        },
      );
    }),
  };
}
