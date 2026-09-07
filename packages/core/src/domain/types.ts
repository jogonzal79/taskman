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

/**
 * Orden final y autoritativo de una columna, leido de la base tras escribir.
 * El campo se llama `taskOrder` porque asi lo nombran la 5.1 y la 6.3.3 de la
 * especificacion; el borde HTTP lo expone como `task_order`.
 */
export interface ColumnOrder {
  columnId: string;
  taskOrder: string[];
}

export interface MoveResult {
  task: Task;
  fromColumnId: string;
  toColumnId: string;
  /** Origen y destino, o una sola entrada si el movimiento fue intracolumna. */
  affectedColumns: ColumnOrder[];
}

// --- Entradas de las operaciones ---------------------------------------------

export interface CreateTaskInput {
  boardId: string;
  columnId: string;
  title: string;
  description?: string | null;
  priority?: Priority;
  dueDate?: Date | null;
  /** Omitida, la tarea va al final de la columna. */
  position?: TargetPosition;
}

/**
 * Patch parcial: solo los campos presentes se modifican. `position` y
 * `columnId` no estan y no es un olvido, se cambian con `move`.
 *
 * `null` explicito en `description` o `dueDate` los borra; omitirlos los deja
 * como estan. Con `exactOptionalPropertyTypes` los dos casos son distinguibles
 * en el tipo, no solo por convencion.
 */
export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: Priority;
  dueDate?: Date | null;
}

// --- Listado y busqueda ------------------------------------------------------

export type TaskOrderBy = "position" | "dueDate" | "priority" | "createdAt";

export interface ListTasksQuery {
  boardId?: string;
  columnId?: string;
  /** Varias prioridades actuan como OR. */
  priority?: readonly Priority[];
  dueBefore?: Date;
  dueAfter?: Date;
  /** Vencidas: `due_date` anterior a hoy y fuera de la columna DONE. */
  overdue?: boolean;
  orderBy?: TaskOrderBy;
  limit?: number;
  cursor?: string;
}

export interface SearchScope {
  boardId?: string;
  columnId?: string;
  limit?: number;
  cursor?: string;
}

export interface TaskMatch {
  task: Task;
  /** Relevancia de PostgreSQL (`ts_rank`). Mayor es mas relevante. */
  rank: number;
}

export interface Page<T> {
  items: T[];
  /** `null` cuando no hay mas paginas. */
  nextCursor: string | null;
}

export const LIMITE_PAGINA_DEFECTO = 50;
export const LIMITE_PAGINA_MAXIMO = 200;
