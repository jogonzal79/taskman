import type { Board, BoardDetail, Column, Task } from "./types.js";

/**
 * La forma de un evento de auditoria (7.4), como DATO.
 *
 * Aca no se escribe nada: esto es solo QUE se registra. El COMO —y sobre todo
 * el DONDE, que es la misma transaccion que la operacion auditada— vive en
 * `AuditService`. Separarlo permite que la tabla de la 7.4 sea literal en el
 * codigo: cada constructor de abajo fija una fila de esa tabla, y un servicio
 * no puede inventarse una combinacion que la tabla no contempla.
 *
 * Los payloads van en snake_case, igual que el JSON de la 8.5 y el de la API
 * REST de la 6.3: es el mismo dato visto desde otro lado, y la 7.4 ya escribe
 * `{ column_id, position }` con ese estilo.
 */

export type AuditAction = "CREATE" | "UPDATE" | "MOVE" | "DELETE";

/** Se corresponde con `entity_type`. Son las tres entidades de dominio. */
export type AuditEntityType = "board" | "column" | "task";

export type ValorJson = string | number | boolean | null | ValorJson[] | { [clave: string]: ValorJson };

export type AuditPayload = Record<string, ValorJson>;

export interface AuditEvent {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  beforeData: AuditPayload | null;
  afterData: AuditPayload | null;
}

// --- Serializacion de entidades ----------------------------------------------

function instante(fecha: Date): string {
  return fecha.toISOString();
}

/** `due_date` es DATE en la base: sin hora ni zona, igual que en el borde. */
function fechaSola(fecha: Date | null): string | null {
  return fecha === null ? null : fecha.toISOString().slice(0, 10);
}

export function tableroCompleto(tablero: Board): AuditPayload {
  return {
    id: tablero.id,
    name: tablero.name,
    description: tablero.description,
    created_at: instante(tablero.createdAt),
    updated_at: instante(tablero.updatedAt),
  };
}

export function columnaCompleta(columna: Column): AuditPayload {
  return {
    id: columna.id,
    board_id: columna.boardId,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    created_at: instante(columna.createdAt),
    updated_at: instante(columna.updatedAt),
  };
}

export function tareaCompleta(tarea: Task): AuditPayload {
  return {
    id: tarea.id,
    board_id: tarea.boardId,
    column_id: tarea.columnId,
    title: tarea.title,
    description: tarea.description,
    priority: tarea.priority,
    due_date: fechaSola(tarea.dueDate),
    position: tarea.position,
    created_at: instante(tarea.createdAt),
    updated_at: instante(tarea.updatedAt),
  };
}

/**
 * Un tablero recien creado se registra CON sus columnas.
 *
 * Es una sola operacion y deja un solo registro, no cinco: la 5.2 usa el mismo
 * criterio para el borrado de un tablero ("un unico evento de auditoria con el
 * recuento de entidades eliminadas"), y un CREATE por columna repartiria en
 * varias filas algo que ocurrio de forma indivisible. Las columnas van enteras
 * y no contadas porque son parte de lo que define al tablero, y son cuatro.
 */
export function tableroConColumnas(tablero: BoardDetail): AuditPayload {
  return {
    ...tableroCompleto(tablero),
    columns: tablero.columns.map(columnaCompleta),
  };
}

/** Lo que la 7.4 pide para MOVE, en las dos puntas: `{ column_id, position }`. */
export function ubicacion(tarea: { columnId: string; position: number }): AuditPayload {
  return { column_id: tarea.columnId, position: tarea.position };
}

// --- Campos modificados (UPDATE) ---------------------------------------------

/**
 * Un campo comparable de una entidad. `leer` devuelve el valor YA serializado,
 * asi que dos fechas se comparan como dos cadenas y no por identidad de objeto.
 */
export interface CampoAuditado<T> {
  nombre: string;
  leer(entidad: T): ValorJson;
}

export const CAMPOS_TABLERO: ReadonlyArray<CampoAuditado<Board>> = [
  { nombre: "name", leer: (b) => b.name },
  { nombre: "description", leer: (b) => b.description },
];

export const CAMPOS_COLUMNA: ReadonlyArray<CampoAuditado<Column>> = [
  { nombre: "name", leer: (c) => c.name },
  { nombre: "position", leer: (c) => c.position },
];

export const CAMPOS_TAREA: ReadonlyArray<CampoAuditado<Task>> = [
  { nombre: "title", leer: (t) => t.title },
  { nombre: "description", leer: (t) => t.description },
  { nombre: "priority", leer: (t) => t.priority },
  { nombre: "due_date", leer: (t) => fechaSola(t.dueDate) },
];

export interface Cambios {
  before: AuditPayload;
  after: AuditPayload;
}

/**
 * Solo los campos que de verdad cambiaron, con su valor previo y el nuevo
 * (7.4). `null` cuando no cambio ninguno, que es como la 5.2 distingue el patch
 * sin efecto: la operacion es exitosa y NO deja registro.
 */
export function camposModificados<T>(
  antes: T,
  despues: T,
  campos: ReadonlyArray<CampoAuditado<T>>,
): Cambios | null {
  const before: AuditPayload = {};
  const after: AuditPayload = {};
  let hayCambios = false;

  for (const campo of campos) {
    const previo = campo.leer(antes);
    const nuevo = campo.leer(despues);
    if (previo === nuevo) {
      continue;
    }
    before[campo.nombre] = previo;
    after[campo.nombre] = nuevo;
    hayCambios = true;
  }

  return hayCambios ? { before, after } : null;
}

// --- Constructores de evento (la tabla de la 7.4) ----------------------------

export function creacion(
  entityType: AuditEntityType,
  entityId: string,
  entidad: AuditPayload,
): AuditEvent {
  return { action: "CREATE", entityType, entityId, beforeData: null, afterData: entidad };
}

export function actualizacion(
  entityType: AuditEntityType,
  entityId: string,
  cambios: Cambios,
): AuditEvent {
  return {
    action: "UPDATE",
    entityType,
    entityId,
    beforeData: cambios.before,
    afterData: cambios.after,
  };
}

export function movimiento(
  taskId: string,
  antes: AuditPayload,
  despues: AuditPayload,
): AuditEvent {
  return {
    action: "MOVE",
    entityType: "task",
    entityId: taskId,
    beforeData: antes,
    afterData: despues,
  };
}

/**
 * DELETE con la entidad completa en `before_data` (7.4): tiene que alcanzar
 * para saber que se perdio, no solo que algo se perdio.
 *
 * `cascade` es el unico agregado a la entidad, y aparece solo cuando el borrado
 * se llevo o movio otras filas: el tablero arrastra sus columnas y sus tareas
 * (la 5.2 pide justamente ese recuento), y una columna con `reassignTo` no
 * pierde sus tareas sino que las cede. Sin ese dato, el registro de un tablero
 * borrado no distingue uno vacio de uno con doscientas tareas.
 */
export function borrado(
  entityType: AuditEntityType,
  entityId: string,
  entidad: AuditPayload,
  cascade?: AuditPayload,
): AuditEvent {
  return {
    action: "DELETE",
    entityType,
    entityId,
    beforeData: cascade === undefined ? entidad : { ...entidad, cascade },
    afterData: null,
  };
}
