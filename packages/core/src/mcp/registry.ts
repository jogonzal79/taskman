import type { TaskManagerPort } from "./port.js";
import type { McpToolDefinition } from "./tool.js";
import { definirCreateTask } from "./tools/create-task.js";
import { definirListTasks } from "./tools/list-tasks.js";
import { definirMoveTask } from "./tools/move-task.js";

/**
 * El registro unico de herramientas de la 8.1.
 *
 * Es una funcion del puerto y nada mas: la misma lista sirve para el transporte
 * stdio y, cuando exista, para el Streamable HTTP, sin que ninguno de los dos
 * pueda quedarse con una version distinta del catalogo.
 *
 * F2.1 tiene tres de las once de la 8.2. No es una reduccion del catalogo: es
 * el subconjunto con el que un agente ya puede operar un tablero de punta a
 * punta —listar, crear, mover— que es lo que este paso tiene que poder probar.
 */
export function crearHerramientas(port: TaskManagerPort): McpToolDefinition[] {
  return [definirListTasks(port), definirCreateTask(port), definirMoveTask(port)];
}
