import { z } from "zod";

import type { Column, Task } from "../../domain/types.js";
import { fechaIso } from "../respuesta.js";

/**
 * Campos compartidos por los esquemas de entrada, y las proyecciones que
 * aparecen en los bloques JSON de salida.
 *
 * Las descripciones NO son comentarios: la 8.4 las declara parte del contrato,
 * y de ellas depende directamente que el agente acierte. Por eso cada una dice
 * que forma acepta el campo y que pasa en el caso raro (una key que no existe,
 * un indice mayor que la columna), en vez de repetir el nombre del campo.
 */

export const PRIORIDADES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const prioridad = z.enum(PRIORIDADES);

export const campoBoard = z
  .string()
  .describe(
    "Tablero, por id (UUID) o por nombre exacto sin distinguir mayusculas. " +
      "Si el nombre coincide con varios tableros la herramienta responde AMBIGUOUS_MATCH con los candidatos y no elige por vos.",
  );

export const campoColumn = z
  .string()
  .describe(
    "Columna del tablero, por id (UUID), por key (BACKLOG, TODO, IN_PROGRESS, DONE) o por nombre visible ('Por hacer'). " +
      "La key admite espacios en lugar de guiones bajos: 'IN PROGRESS' resuelve a IN_PROGRESS.",
  );

export const campoPosition = z
  .union([z.number().int().min(0), z.literal("end")])
  .default("end")
  .describe(
    "Posicion 0-based dentro de la columna destino, o 'end' para el final. " +
      "Un indice mayor que el numero de tareas de la columna se ajusta al final en vez de fallar.",
  );

// --- Proyecciones de salida --------------------------------------------------

/** La tarea tal como la ve el agente: snake_case, igual que la 6.3.1. */
export function tareaJson(tarea: Task, columnKey: string | null): Record<string, unknown> {
  return {
    id: tarea.id,
    title: tarea.title,
    description: tarea.description,
    priority: tarea.priority,
    due_date: fechaIso(tarea.dueDate),
    board_id: tarea.boardId,
    column_id: tarea.columnId,
    column_key: columnKey,
    position: tarea.position,
  };
}

export function columnaJson(columna: Column): Record<string, unknown> {
  return {
    id: columna.id,
    key: columna.key,
    name: columna.name,
    position: columna.position,
  };
}

/** "1 tarea" / "3 tareas". El texto lo lee un modelo que despues lo repite. */
export function cuentaTareas(cantidad: number): string {
  return cantidad === 1 ? "1 tarea" : `${cantidad} tareas`;
}

/** Una linea de tarea legible: lo que el agente parafrasea al usuario. */
export function tareaLinea(tarea: Task): string {
  const partes = [`"${tarea.title}"`, tarea.priority];
  const vence = fechaIso(tarea.dueDate);
  if (vence !== null) {
    partes.push(`vence ${vence}`);
  }
  return `    - ${partes.join("  ")}`;
}
