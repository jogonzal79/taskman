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
} from "../domain/types.js";

/**
 * Lo que las herramientas MCP necesitan del sistema, y nada mas.
 *
 * Existe para que el registro de herramientas sea uno solo (8.1) y funcione
 * con los servicios en proceso (`CorePort`) o, mas adelante, contra la API REST
 * (`HttpPort`, que todavia no existe). Las herramientas no conocen ninguna de
 * las dos implementaciones: solo esta interfaz.
 *
 * Sigue siendo mas chica que el catalogo completo de la 8.2 —falta `deleteTask`,
 * que llega con delete_task y su politica de confirmacion (8.3.2)— porque una
 * interfaz con metodos que nadie implementa contra la API real no es un
 * contrato, es una promesa.
 *
 * Los tipos que entran y salen son los del dominio, no los del borde: la
 * traduccion a snake_case y a texto legible ocurre en las herramientas.
 */
export interface TaskManagerPort {
  /** Tambien resuelve un tablero por nombre: no hay busqueda por nombre en el nucleo. */
  listBoards(query: ListBoardsQuery): Promise<Page<Board>>;
  /** Con sus columnas: es como se resuelve una columna por key o por nombre. */
  getBoard(boardId: string): Promise<BoardDetail>;
  createBoard(input: CreateBoardInput): Promise<BoardDetail>;
  createColumn(input: CreateColumnInput): Promise<Column>;
  listTasks(query: ListTasksQuery): Promise<Page<Task>>;
  /**
   * Para resolver el tablero de una tarea dada por id: sin el, `to_column` se
   * resolveria por key cuando falta `board` y por nombre cuando esta, y la
   * regla de la 8.3.1 dejaria de ser una sola.
   */
  getTask(taskId: string): Promise<Task>;
  createTask(input: CreateTaskInput): Promise<Task>;
  /** Patch parcial. `columnId` y `position` no se tocan aca: son `moveTask`. */
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task>;
  moveTask(taskId: string, target: MoveTarget): Promise<MoveResult>;
  /** Texto completo sobre titulo y descripcion. El ambito puede ser global. */
  searchTasks(text: string, scope: SearchScope): Promise<Page<TaskMatch>>;
}
