/**
 * Tipos del dominio. Deliberadamente NO son los tipos generados por Prisma:
 * el repositorio es la unica capa que ve Prisma y mapea a estas formas, asi
 * los adaptadores no terminan dependiendo del generador (ver CLAUDE.md).
 */

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export interface Task {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: Priority;
  dueDate: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Posicion destino: un indice concreto o el final de la columna. */
export type TargetPosition = number | "end";

export interface MoveTarget {
  columnId: string;
  position: TargetPosition;
}

/** Orden final y autoritativo de una columna, leido de la base tras escribir. */
export interface ColumnOrder {
  columnId: string;
  taskIds: string[];
}

export interface MoveResult {
  task: Task;
  fromColumnId: string;
  toColumnId: string;
  /** Origen y destino, o una sola entrada si el movimiento fue intracolumna. */
  affectedColumns: ColumnOrder[];
}
