import type { TaskManagerPort } from "./port.js";
import type { McpToolDefinition } from "./tool.js";
import { definirCreateBoard } from "./tools/create-board.js";
import { definirCreateColumn } from "./tools/create-column.js";
import { definirCreateTask } from "./tools/create-task.js";
import { definirGetBoard } from "./tools/get-board.js";
import { definirGetTask } from "./tools/get-task.js";
import { definirListBoards } from "./tools/list-boards.js";
import { definirListTasks } from "./tools/list-tasks.js";
import { definirMoveTask } from "./tools/move-task.js";
import { definirSearchTasks } from "./tools/search-tasks.js";
import { definirUpdateTask } from "./tools/update-task.js";

/**
 * El registro unico de herramientas de la 8.1.
 *
 * Es una funcion del puerto y nada mas: la misma lista sirve para el transporte
 * stdio y, cuando exista, para el Streamable HTTP, sin que ninguno de los dos
 * pueda quedarse con una version distinta del catalogo.
 *
 * Estan las diez no destructivas de la 8.2. Falta delete_task, la unica
 * destructiva, que llega con la politica de confirmacion de la 8.3.2: es una
 * decision de producto propia y no una herramienta mas.
 *
 * El orden es el del catalogo de la 8.2 —tableros, columnas, tareas— porque es
 * el orden en que las ve el agente al listar herramientas, y leerlas de lo
 * general a lo particular ayuda a que elija la correcta.
 */
export function crearHerramientas(port: TaskManagerPort): McpToolDefinition[] {
  return [
    definirListBoards(port),
    definirGetBoard(port),
    definirCreateBoard(port),
    definirCreateColumn(port),
    definirListTasks(port),
    definirSearchTasks(port),
    definirGetTask(port),
    definirCreateTask(port),
    definirUpdateTask(port),
    definirMoveTask(port),
  ];
}
