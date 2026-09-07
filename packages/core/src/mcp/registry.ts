import { POLITICA_DESTRUCTIVA_POR_DEFECTO, type PoliticaDestructiva } from "./politica.js";
import type { TaskManagerPort } from "./port.js";
import type { McpToolDefinition } from "./tool.js";
import { definirCreateBoard } from "./tools/create-board.js";
import { definirCreateColumn } from "./tools/create-column.js";
import { definirCreateTask } from "./tools/create-task.js";
import { definirDeleteTask } from "./tools/delete-task.js";
import { definirGetBoard } from "./tools/get-board.js";
import { definirGetTask } from "./tools/get-task.js";
import { definirListBoards } from "./tools/list-boards.js";
import { definirListTasks } from "./tools/list-tasks.js";
import { definirMoveTask } from "./tools/move-task.js";
import { definirSearchTasks } from "./tools/search-tasks.js";
import { definirUpdateTask } from "./tools/update-task.js";

export interface OpcionesRegistro {
  /** MCP_DESTRUCTIVE_POLICY (8.3.2). Ausente equivale a `confirm`. */
  politicaDestructiva?: PoliticaDestructiva;
}

/**
 * El registro unico de herramientas de la 8.1.
 *
 * Es una funcion del puerto y de la configuracion, y nada mas: la misma lista
 * sirve para el transporte stdio y, cuando exista, para el Streamable HTTP, sin
 * que ninguno de los dos pueda quedarse con una version distinta del catalogo.
 *
 * Estan las once de la 8.2. La lista se devuelve COMPLETA incluso cuando la
 * politica es `deny`: delete_task viene entonces con `anunciada: false` y un
 * handler que explica por que no se puede. El transporte la registra igual y no
 * la ofrece, que es el filtrado en el listado que pide la 8.1; omitirla aca
 * daria "herramienta desconocida", que no distingue una politica de un error.
 *
 * El orden es el del catalogo de la 8.2 —tableros, columnas, tareas— porque es
 * el orden en que las ve el agente al listar herramientas, y leerlas de lo
 * general a lo particular ayuda a que elija la correcta.
 */
export function crearHerramientas(
  port: TaskManagerPort,
  opciones: OpcionesRegistro = {},
): McpToolDefinition[] {
  const politica = opciones.politicaDestructiva ?? POLITICA_DESTRUCTIVA_POR_DEFECTO;

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
    definirDeleteTask(port, politica),
  ];
}
