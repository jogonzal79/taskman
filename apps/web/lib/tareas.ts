import type { Tarea } from "@taskman/contracts";
import type { Task } from "@taskman/core";

/**
 * La traduccion de una tarea entre el borde HTTP y el dominio (6.1), incluido lo
 * unico delicado que tiene: `due_date`.
 *
 * Sale a `lib/` por lo mismo que `aColumnaSalida`: la van a necesitar POST
 * /api/tasks, GET /api/tasks/{id} y los endpoints de tarea que faltan, y copiarla
 * en cada uno dejaria varias versiones de la conversion de fecha libres de
 * separarse. Esa es justo la que no puede tener dos versiones.
 */

/**
 * `AAAA-MM-DD` a `Date`, anclada a MEDIANOCHE UTC.
 *
 * La `Z` no es decorativa: `new Date("2026-09-11")` y
 * `new Date("2026-09-11T00:00")` dan dias distintos segun la zona del proceso
 * —el segundo se interpreta en hora local—, asi que sin anclar, la misma peticion
 * guardaria fechas distintas segun donde corra el servidor. La columna es DATE,
 * sin hora ni zona, y el unico instante que representa el dia sin ambiguedad es
 * su medianoche UTC.
 *
 * El formato y la existencia del dia ya los valido el contrato (`fechaSola`), asi
 * que aca no se vuelve a comprobar: seria una segunda definicion de fecha valida.
 */
export function aFechaUtc(valor: string): Date {
  return new Date(`${valor}T00:00:00.000Z`);
}

/**
 * `Date` a `AAAA-MM-DD`. Lee las partes en UTC —`toISOString`— y no en hora
 * local: `getDate()` sobre la medianoche UTC de una fecha devuelve el dia
 * ANTERIOR en cualquier zona al oeste de Greenwich, que es el corrimiento de un
 * dia clasico de este campo.
 */
export function aFechaIso(fecha: Date | null): string | null {
  return fecha === null ? null : fecha.toISOString().slice(0, 10);
}

export function aTareaSalida(tarea: Task): Tarea {
  return {
    id: tarea.id,
    board_id: tarea.boardId,
    column_id: tarea.columnId,
    title: tarea.title,
    description: tarea.description,
    priority: tarea.priority,
    due_date: aFechaIso(tarea.dueDate),
    position: tarea.position,
    // created_at y updated_at SI llevan hora y zona (6.1): son timestamptz, no
    // DATE, y aca se serializan completos a proposito.
    created_at: tarea.createdAt.toISOString(),
    updated_at: tarea.updatedAt.toISOString(),
  };
}
