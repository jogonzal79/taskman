import type { ColumnReference } from "./column-key.js";

/**
 * Tipos del dominio. Deliberadamente NO son los tipos generados por Prisma:
 * el repositorio es la unica capa que ve Prisma y mapea a estas formas, asi
 * los adaptadores no terminan dependiendo del generador (ver CLAUDE.md).
 */

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export interface Board {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Column {
  id: string;
  boardId: string;
  name: string;
  /** Estable y en mayusculas: es como los agentes referencian la columna. */
  key: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Un tablero con sus columnas en orden: es como se lo consulta siempre. */
export interface BoardDetail extends Board {
  columns: Column[];
}

/** Una columna con cuantas tareas tiene. Ver `BoardWithTaskCounts`. */
export interface ColumnWithTaskCount extends Column {
  taskCount: number;
}

/**
 * Lo que devuelve GET /api/boards/{id} (6.2): el tablero, sus columnas en
 * orden y el recuento de tareas de cada una, mas el total.
 *
 * Es un tipo aparte y no un campo agregado a `Column` porque el recuento no es
 * un atributo de la columna: es una agregacion que solo esta vista pide. Meterlo
 * en `Column` obligaria a calcularlo (o a mentir con un cero) en cada uno de los
 * caminos que hoy devuelven columnas sin contar nada.
 */
export interface BoardWithTaskCounts extends Board {
  columns: ColumnWithTaskCount[];
  taskCount: number;
}

export interface CreateBoardInput {
  name: string;
  description?: string | null;
  /** Omitidas, se crean las cuatro columnas por defecto de la 4.3. */
  columns?: ReadonlyArray<{ name: string; key: string }>;
}

export interface UpdateBoardInput {
  name?: string;
  description?: string | null;
}

export interface ListBoardsQuery {
  limit?: number;
  cursor?: string;
}

export interface CreateColumnInput {
  boardId: string;
  name: string;
  key: string;
  /** Omitida, la columna va al final del tablero. */
  position?: TargetPosition;
}

/**
 * Renombrar o reordenar (6.2). `key` no esta: las keys son estables porque los
 * agentes resuelven referencias con ellas.
 */
export interface UpdateColumnInput {
  name?: string;
  position?: TargetPosition;
}

export interface DeleteColumnOptions {
  /** Columna del mismo tablero a la que van a parar las tareas. */
  reassignTo?: string;
}

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

/**
 * Destino de un movimiento: la columna por id o por key, mas la posicion.
 * Si vienen las dos formas, `columnId` prevalece (6.3.1).
 */
export type MoveTarget = ColumnReference & {
  position: TargetPosition;
};

/**
 * Orden final y autoritativo de una columna, leido de la base tras escribir.
 * El campo se llama `taskOrder` porque asi lo nombran la 5.1 y la 6.3.3 de la
 * especificacion; el borde HTTP lo expone como `task_order`.
 */
export interface ColumnOrder {
  columnId: string;
  taskOrder: string[];
}

/**
 * Lo que produce crear una columna: la columna creada y TODAS las del tablero
 * en el orden que quedo.
 *
 * `ColumnService.create` sigue DEVOLVIENDO solo la columna —es lo que necesitan
 * sus llamadores, y el borde MCP no publica el orden— pero se lo pasa entero al
 * participante de la 6.5, porque el cuerpo que POST /api/boards/{id}/columns
 * responde son las dos cosas. El orden solo existe DESPUES de reescribir las
 * positions, y quien lo lea fuera de la transaccion puede ver el de otro
 * momento, asi que el registro de idempotencia tiene que guardar el que ESTA
 * transaccion produjo.
 */
export interface ColumnWithOrder {
  column: Column;
  columns: Column[];
}

export interface MoveResult {
  task: Task;
  fromColumnId: string;
  toColumnId: string;
  /** Origen y destino, o una sola entrada si el movimiento fue intracolumna. */
  affectedColumns: ColumnOrder[];
}

// --- Entradas de las operaciones ---------------------------------------------

export type CreateTaskInput = ColumnReference & {
  boardId: string;
  title: string;
  description?: string | null;
  priority?: Priority;
  dueDate?: Date | null;
  /** Omitida, la tarea va al final de la columna. */
  position?: TargetPosition;
};

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
  /** Alternativa a `columnId` dentro del tablero indicado (6.3.2). */
  columnKey?: string;
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
