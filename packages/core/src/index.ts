export { DomainError, isDomainError } from "./domain/errors";
export type { DomainErrorCode, DomainErrorOptions } from "./domain/errors";

export type {
  Board,
  BoardDetail,
  BoardWithTaskCounts,
  Column,
  ColumnOrder,
  ColumnWithOrder,
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
} from "./domain/types";
export { LIMITE_PAGINA_DEFECTO, LIMITE_PAGINA_MAXIMO } from "./domain/types";

export type { ActorContext, ActorType } from "./domain/actor";
export {
  leerNivelLog,
  LOGGER_NULO,
  NIVEL_LOG_POR_DEFECTO,
  NIVELES_LOG,
} from "./domain/logger";
export type { CamposDeLog, Logger, NivelLog } from "./domain/logger";
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
} from "./domain/audit";
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
} from "./domain/audit";

export { computeMoveOrder } from "./domain/order";
export { LIMITE_TITULO, normalizarTitulo, recortarTitulo } from "./domain/title";

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
} from "./db/db-error";
export type { DbFailure } from "./db/db-error";

export { TaskRepository } from "./db/task-repository";
export type {
  ColumnRef,
  LockedTask,
  MoveTransaction,
  NewTaskRow,
  TaskFields,
  TaskTransaction,
} from "./db/task-repository";

export { AuditQueryService } from "./services/audit-query-service";
export { AuditService } from "./services/audit-service";
export { TaskService } from "./services/task-service";
export { BoardService, COLUMNAS_POR_DEFECTO, LIMITE_BOARD_DESCRIPTION, LIMITE_BOARD_NAME } from "./services/board-service";
export { ColumnService } from "./services/column-service";
export { resolverColumna } from "./services/column-reference";
export type { BuscadorDeColumnas } from "./services/column-reference";

export { AuditRepository, insertAuditRow } from "./db/audit-repository";
export { CANAL_DE_CAMBIOS, leerAvisoDeCambio } from "./db/cambios";
export type { AvisoDeCambio } from "./db/cambios";
export type { AuditRow, AuditTransaction } from "./db/audit-repository";

// --- Idempotencia (6.5) ------------------------------------------------------

export { IdempotencyRepository, insertIdempotencyRow } from "./db/idempotency-repository";
export type {
  EscrituraIdempotente,
  IdempotencyRecord,
  IdempotencyRow,
} from "./db/idempotency-repository";
export type { ParticipanteIdempotente } from "./services/participante";
export { BoardRepository } from "./db/board-repository";
export type { BoardTransaction, LockedColumn, NewBoardRow, NewColumnRow } from "./db/board-repository";
export { TransactionRunner } from "./db/transaction-runner";
export { comprobarConexion } from "./db/health";

export { LIMITE_COLUMN_KEY, LIMITE_COLUMN_NAME, normalizarColumnKey } from "./domain/column-key";
export type { ColumnReference } from "./domain/column-key";
export { COLUMNA_TERMINAL, esVencida } from "./domain/vencimiento";
export { normalizarTexto, recortarBlancos } from "./domain/text";

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
} from "./domain/api-key";
export type { Scope } from "./domain/api-key";
export { buscarClavePorPrefijo } from "./db/api-key-repository";
export type { ApiKeyRow } from "./db/api-key-repository";
export {
  conCache,
  reiniciarCacheDeClaves,
  VENTANA_CACHE_MS,
} from "./services/api-key-cache";
export { ApiKeyService } from "./services/api-key-service";
export type {
  BuscadorDeClaves,
  ClaveAutenticada,
  OpcionesApiKeyService,
  ResultadoAutenticacion,
} from "./services/api-key-service";

// --- MCP: registro unico de herramientas y puerto (8.1) ----------------------
// El nucleo declara las herramientas como dato y NO importa el SDK de MCP: cada
// app las monta sobre su propio transporte (ver src/mcp/tool.ts).

export { crearHerramientas } from "./mcp/registry";
export type { OpcionesRegistro } from "./mcp/registry";
export {
  leerPoliticaDestructiva,
  POLITICAS_DESTRUCTIVAS,
  POLITICA_DESTRUCTIVA_POR_DEFECTO,
} from "./mcp/politica";
export type { PoliticaDestructiva } from "./mcp/politica";
export {
  contextoDeAgente,
  ACTOR_MCP_DESCONOCIDO,
  CONTEXTO_MCP_POR_DEFECTO,
} from "./mcp/contexto";
export type { FabricaDeContexto } from "./mcp/contexto";
export type { EntornoMcp, Llamada } from "./mcp/llamada";
export type { TaskManagerPort } from "./mcp/port";
export { CorePort, crearCorePort } from "./mcp/core-port";
export type {
  EsquemaEntrada,
  McpTextContent,
  McpToolDefinition,
  McpToolResult,
} from "./mcp/tool";
export { esUuid, resolverReferencia, MAXIMO_SUGERENCIAS } from "./mcp/resolve";
export type {
  AmbitoResolucion,
  Candidato,
  EntidadResuelta,
  EstrategiaResolucion,
} from "./mcp/resolve";
