export { DomainError, isDomainError } from "./domain/errors.js";
export type { DomainErrorCode, DomainErrorOptions } from "./domain/errors.js";

export type {
  ColumnOrder,
  CreateTaskInput,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  Priority,
  SearchScope,
  TargetPosition,
  Task,
  TaskMatch,
  TaskOrderBy,
  UpdateTaskInput,
} from "./domain/types.js";
export { LIMITE_PAGINA_DEFECTO, LIMITE_PAGINA_MAXIMO } from "./domain/types.js";

export { computeMoveOrder } from "./domain/order.js";
export { LIMITE_TITULO, normalizarTitulo, recortarTitulo } from "./domain/title.js";

export {
  describeDbFailure,
  isRetryableConflict,
  isSerializationFailure,
  violatesConstraint,
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  TASK_POSITION_CONSTRAINT,
} from "./db/db-error.js";
export type { DbFailure } from "./db/db-error.js";

export { TaskRepository } from "./db/task-repository.js";
export type {
  ColumnRef,
  LockedTask,
  MoveTransaction,
  NewTaskRow,
  TaskFields,
  TaskTransaction,
} from "./db/task-repository.js";

export { TaskService } from "./services/task-service.js";
