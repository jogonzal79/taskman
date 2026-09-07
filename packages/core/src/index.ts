export { DomainError, isDomainError } from "./domain/errors.js";
export type { DomainErrorCode, DomainErrorOptions } from "./domain/errors.js";

export type {
  Board,
  BoardDetail,
  Column,
  ColumnOrder,
  CreateBoardInput,
  CreateColumnInput,
  CreateTaskInput,
  DeleteColumnOptions,
  ListBoardsQuery,
  UpdateBoardInput,
  UpdateColumnInput,
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
  COLUMN_KEY_CONSTRAINT,
  COLUMN_POSITION_CONSTRAINT,
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
export { BoardService, COLUMNAS_POR_DEFECTO, LIMITE_BOARD_DESCRIPTION, LIMITE_BOARD_NAME } from "./services/board-service.js";
export { ColumnService } from "./services/column-service.js";
export { resolverColumna } from "./services/column-reference.js";
export type { BuscadorDeColumnas } from "./services/column-reference.js";

export { BoardRepository } from "./db/board-repository.js";
export type { BoardTransaction, LockedColumn, NewBoardRow, NewColumnRow } from "./db/board-repository.js";
export { TransactionRunner } from "./db/transaction-runner.js";

export { LIMITE_COLUMN_KEY, LIMITE_COLUMN_NAME, normalizarColumnKey } from "./domain/column-key.js";
export type { ColumnReference } from "./domain/column-key.js";
export { normalizarTexto, recortarBlancos } from "./domain/text.js";

// --- MCP: registro unico de herramientas y puerto (8.1) ----------------------
// El nucleo declara las herramientas como dato y NO importa el SDK de MCP: cada
// app las monta sobre su propio transporte (ver src/mcp/tool.ts).

export { crearHerramientas } from "./mcp/registry.js";
export type { TaskManagerPort } from "./mcp/port.js";
export { CorePort, crearCorePort } from "./mcp/core-port.js";
export type {
  EsquemaEntrada,
  McpTextContent,
  McpToolDefinition,
  McpToolResult,
} from "./mcp/tool.js";
export { esUuid, resolverReferencia, MAXIMO_SUGERENCIAS } from "./mcp/resolve.js";
export type { AmbitoResolucion, Candidato } from "./mcp/resolve.js";
