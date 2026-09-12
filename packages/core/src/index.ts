export { DomainError, isDomainError } from "./domain/errors.js";
export type { DomainErrorCode, DomainErrorOptions } from "./domain/errors.js";

export type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  Column,
  ColumnOrder,
  ColumnWithTaskCount,
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

export type { ActorContext, ActorType } from "./domain/actor.js";
export { LOGGER_NULO } from "./domain/logger.js";
export type { CamposDeLog, Logger } from "./domain/logger.js";
export {
  actualizacion,
  borrado,
  camposModificados,
  columnaCompleta,
  creacion,
  movimiento,
  tableroCompleto,
  tableroConColumnas,
  tareaCompleta,
  ubicacion,
  CAMPOS_COLUMNA,
  CAMPOS_TABLERO,
  CAMPOS_TAREA,
} from "./domain/audit.js";
export type {
  AuditAction,
  AuditEntityType,
  AuditEntry,
  AuditEvent,
  AuditPayload,
  ListAuditQuery,
  Cambios,
  CampoAuditado,
  ValorJson,
} from "./domain/audit.js";

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
  IDEMPOTENCY_PK_CONSTRAINT,
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

export { AuditQueryService } from "./services/audit-query-service.js";
export { AuditService } from "./services/audit-service.js";
export { TaskService } from "./services/task-service.js";
export { BoardService, COLUMNAS_POR_DEFECTO, LIMITE_BOARD_DESCRIPTION, LIMITE_BOARD_NAME } from "./services/board-service.js";
export { ColumnService } from "./services/column-service.js";
export { resolverColumna } from "./services/column-reference.js";
export type { BuscadorDeColumnas } from "./services/column-reference.js";

export { AuditRepository, insertAuditRow } from "./db/audit-repository.js";
export type { AuditRow, AuditTransaction } from "./db/audit-repository.js";

// --- Idempotencia (6.5) ------------------------------------------------------

export { IdempotencyRepository, insertIdempotencyRow } from "./db/idempotency-repository.js";
export type {
  EscrituraIdempotente,
  IdempotencyRecord,
  IdempotencyRow,
} from "./db/idempotency-repository.js";
export type { ParticipanteIdempotente } from "./services/participante.js";
export { BoardRepository } from "./db/board-repository.js";
export type { BoardTransaction, LockedColumn, NewBoardRow, NewColumnRow } from "./db/board-repository.js";
export { TransactionRunner } from "./db/transaction-runner.js";
export { comprobarConexion } from "./db/health.js";

export { LIMITE_COLUMN_KEY, LIMITE_COLUMN_NAME, normalizarColumnKey } from "./domain/column-key.js";
export type { ColumnReference } from "./domain/column-key.js";
export { normalizarTexto, recortarBlancos } from "./domain/text.js";

// --- API keys (ADR-005, 7.1 y 7.2) ------------------------------------------

export {
  esScope,
  generarClave,
  hashearClave,
  hashesIguales,
  prefijoDe,
  LARGO_PREFIJO_VISIBLE,
  PREFIJO_CLAVE,
  SCOPES,
} from "./domain/api-key.js";
export type { Scope } from "./domain/api-key.js";
export { buscarClavePorPrefijo } from "./db/api-key-repository.js";
export type { ApiKeyRow } from "./db/api-key-repository.js";
export { ApiKeyService } from "./services/api-key-service.js";
export type {
  BuscadorDeClaves,
  ClaveAutenticada,
  OpcionesApiKeyService,
  ResultadoAutenticacion,
} from "./services/api-key-service.js";

// --- MCP: registro unico de herramientas y puerto (8.1) ----------------------
// El nucleo declara las herramientas como dato y NO importa el SDK de MCP: cada
// app las monta sobre su propio transporte (ver src/mcp/tool.ts).

export { crearHerramientas } from "./mcp/registry.js";
export type { OpcionesRegistro } from "./mcp/registry.js";
export {
  leerPoliticaDestructiva,
  POLITICAS_DESTRUCTIVAS,
  POLITICA_DESTRUCTIVA_POR_DEFECTO,
} from "./mcp/politica.js";
export type { PoliticaDestructiva } from "./mcp/politica.js";
export {
  contextoDeAgente,
  ACTOR_MCP_DESCONOCIDO,
  CONTEXTO_MCP_POR_DEFECTO,
} from "./mcp/contexto.js";
export type { FabricaDeContexto } from "./mcp/contexto.js";
export type { EntornoMcp, Llamada } from "./mcp/llamada.js";
export type { TaskManagerPort } from "./mcp/port.js";
export { CorePort, crearCorePort } from "./mcp/core-port.js";
export type {
  EsquemaEntrada,
  McpTextContent,
  McpToolDefinition,
  McpToolResult,
} from "./mcp/tool.js";
export { esUuid, resolverReferencia, MAXIMO_SUGERENCIAS } from "./mcp/resolve.js";
export type {
  AmbitoResolucion,
  Candidato,
  EntidadResuelta,
  EstrategiaResolucion,
} from "./mcp/resolve.js";
