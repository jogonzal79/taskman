import { z } from "zod";

import { DomainError } from "../../domain/errors";
import type { Board, Column, Task } from "../../domain/types";
import { fechaIso } from "../respuesta";

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

/**
 * La referencia a una tarea, con la accion de cada herramienta metida en la
 * frase. La parte que importa —que un titulo ambiguo NO se resuelve solo— se
 * escribe una vez para las tres herramientas que aceptan una tarea.
 */
export function campoTask(accion: string): z.ZodString {
  return z
    .string()
    .describe(
      `Tarea ${accion}, por id (UUID) o por titulo exacto sin distinguir mayusculas. ` +
        "Si el titulo coincide con varias tareas del tablero, la herramienta responde AMBIGUOUS_MATCH con los candidatos, sus ids y su columna, y no elige por vos.",
    );
}

/** El ambito de una tarea referida por titulo. Ver `ubicarTarea` en lookup.ts. */
export const campoBoardDeTarea = campoBoard
  .optional()
  .describe(
    "Tablero donde buscar la tarea, por id o por nombre. OBLIGATORIO si `task` es un titulo: la busqueda por titulo nunca es global. " +
      "Innecesario si `task` ya es un id.",
  );

export const campoPosition = z
  .union([z.number().int().min(0), z.literal("end")])
  .default("end")
  .describe(
    "Posicion 0-based dentro de la columna destino, o 'end' para el final. " +
      "Un indice mayor que el numero de tareas de la columna se ajusta al final en vez de fallar.",
  );

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `due_date` llega como fecha sin hora y la columna es DATE: se ancla a
 * medianoche UTC para que no la corra la zona horaria del proceso. Sin la `Z`,
 * `new Date("2026-09-11")` y `new Date("2026-09-11T00:00")` dan dias distintos
 * segun donde corra el servidor.
 */
export function aFecha(valor: string): Date {
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

export function tableroJson(tablero: Board): Record<string, unknown> {
  return {
    id: tablero.id,
    name: tablero.name,
    description: tablero.description,
  };
}

/** "1 tarea" / "3 tareas". El texto lo lee un modelo que despues lo repite. */
export function cuentaTareas(cantidad: number): string {
  return cantidad === 1 ? "1 tarea" : `${cantidad} tareas`;
}

export function cuentaColumnas(cantidad: number): string {
  return cantidad === 1 ? "1 columna" : `${cantidad} columnas`;
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
