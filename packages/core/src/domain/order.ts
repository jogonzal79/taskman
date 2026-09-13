import { DomainError } from "./errors";
import type { TargetPosition } from "./types";

/**
 * Calcula el orden final de las columnas afectadas por un movimiento.
 *
 * Es una funcion pura sobre el estado ya bloqueado: no toca la base. Devuelve
 * la secuencia COMPLETA de cada columna afectada, nunca diferencias, porque el
 * llamador reescribe 0..n-1 entero y asi no hay forma de dejar huecos.
 *
 * Semantica de `position`: se interpreta sobre la columna destino YA SIN la
 * tarea movida, asi que el indice pedido es el indice final de la tarea. Un
 * movimiento intracolumna no es un caso especial: sale del mismo saca-e-inserta.
 */
export function computeMoveOrder(args: {
  taskId: string;
  fromColumnId: string;
  toColumnId: string;
  /** Ids de cada columna afectada, en su orden actual. */
  currentOrder: ReadonlyMap<string, readonly string[]>;
  position: TargetPosition;
}): Map<string, string[]> {
  const { taskId, fromColumnId, toColumnId, currentOrder, position } = args;

  const origen = [...(currentOrder.get(fromColumnId) ?? [])].filter((id) => id !== taskId);
  const esIntracolumna = fromColumnId === toColumnId;
  const destino = esIntracolumna ? origen : [...(currentOrder.get(toColumnId) ?? [])];

  // Una position mayor que el tamano de la columna destino se ajusta al final
  // en vez de fallar; solo una negativa (o no entera) es un error del llamador.
  const indice = position === "end" ? destino.length : Math.min(position, destino.length);
  destino.splice(indice, 0, taskId);

  const resultado = new Map<string, string[]>();
  resultado.set(toColumnId, destino);
  if (!esIntracolumna) {
    resultado.set(fromColumnId, origen);
  }
  return resultado;
}

/** `position` valida: el literal "end" o un entero >= 0. */
export function assertValidPosition(
  position: TargetPosition,
  details: Readonly<Record<string, unknown>>,
): void {
  if (position === "end") {
    return;
  }

  if (!Number.isInteger(position) || position < 0) {
    throw new DomainError("INVALID_ORDER", `La posicion destino no es valida: ${String(position)}.`, {
      details: { ...details, position },
      hint: 'Usa un entero mayor o igual que 0, o el literal "end" para mandar la tarea al final.',
    });
  }
}
