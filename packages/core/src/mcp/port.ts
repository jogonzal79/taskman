import type { ActorContext } from "../domain/actor";
import type {
  Board,
  BoardDetail,
  Column,
  CreateBoardInput,
  CreateColumnInput,
  CreateTaskInput,
  ListBoardsQuery,
  ListTasksQuery,
  MoveResult,
  MoveTarget,
  Page,
  SearchScope,
  Task,
  TaskMatch,
  UpdateTaskInput,
} from "../domain/types";

/**
 * Lo que las herramientas MCP necesitan del sistema, y nada mas.
 *
 * Existe para que el registro de herramientas sea uno solo (8.1) y funcione
 * con los servicios en proceso (`CorePort`) o, mas adelante, contra la API REST
 * (`HttpPort`, que todavia no existe). Las herramientas no conocen ninguna de
 * las dos implementaciones: solo esta interfaz.
 *
 * Cubre el catalogo completo de la 8.2. `deleteTask` es la ultima que llego y
 * la unica destructiva: la politica de confirmacion (8.3.2) NO esta aca, es del
 * borde. El puerto solo dice que el sistema sabe borrar una tarea; si hay que
 * preguntar antes es una decision de la herramienta, y meterla en el puerto
 * obligaria a cada implementacion a repetirla.
 *
 * Los tipos que entran y salen son los del dominio, no los del borde: la
 * traduccion a snake_case y a texto legible ocurre en las herramientas.
 *
 * Las ESCRITURAS reciben `ctx` y las lecturas no (7.4: las lecturas no se
 * auditan). Es la misma asimetria que en los servicios, y esta a proposito:
 * un puerto que pidiera `ctx` para listar tableros obligaria a cada herramienta
 * de lectura a fabricar uno que nadie va a leer.
 */
export interface TaskManagerPort {
  /** Tambien resuelve un tablero por nombre: no hay busqueda por nombre en el nucleo. */
  listBoards(query: ListBoardsQuery): Promise<Page<Board>>;
  /** Con sus columnas: es como se resuelve una columna por key o por nombre. */
  getBoard(boardId: string): Promise<BoardDetail>;
  createBoard(input: CreateBoardInput, ctx: ActorContext): Promise<BoardDetail>;
  createColumn(input: CreateColumnInput, ctx: ActorContext): Promise<Column>;
  listTasks(query: ListTasksQuery): Promise<Page<Task>>;
  /**
   * Para resolver el tablero de una tarea dada por id: sin el, `to_column` se
   * resolveria por key cuando falta `board` y por nombre cuando esta, y la
   * regla de la 8.3.1 dejaria de ser una sola.
   */
  getTask(taskId: string): Promise<Task>;
  createTask(input: CreateTaskInput, ctx: ActorContext): Promise<Task>;
  /** Patch parcial. `columnId` y `position` no se tocan aca: son `moveTask`. */
  updateTask(taskId: string, patch: UpdateTaskInput, ctx: ActorContext): Promise<Task>;
  moveTask(taskId: string, target: MoveTarget, ctx: ActorContext): Promise<MoveResult>;
  /** Unica operacion destructiva del catalogo (8.2). Reindexa su columna. */
  deleteTask(taskId: string, ctx: ActorContext): Promise<void>;
  /** Texto completo sobre titulo y descripcion. El ambito puede ser global. */
  searchTasks(text: string, scope: SearchScope): Promise<Page<TaskMatch>>;
}
