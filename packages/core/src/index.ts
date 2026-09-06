export { DomainError, isDomainError } from "./domain/errors.js";
export type { DomainErrorCode, DomainErrorOptions } from "./domain/errors.js";

export type {
  ColumnOrder,
  MoveResult,
  MoveTarget,
  Priority,
  TargetPosition,
  Task,
} from "./domain/types.js";

export { computeMoveOrder } from "./domain/order.js";

export {
  describeDbFailure,
  isSerializationFailure,
  violatesConstraint,
  SERIALIZATION_FAILURE,
} from "./db/db-error.js";
export type { DbFailure } from "./db/db-error.js";

export { TaskRepository } from "./db/task-repository.js";
export type { ColumnRef, LockedTask, MoveTransaction } from "./db/task-repository.js";

export { TaskService } from "./services/task-service.js";
