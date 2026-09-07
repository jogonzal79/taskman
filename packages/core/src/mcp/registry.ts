import { LOGGER_NULO, type Logger } from "../domain/logger.js";
import { CONTEXTO_MCP_POR_DEFECTO, type FabricaDeContexto } from "./contexto.js";
import type { EntornoMcp } from "./llamada.js";
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
  /**
   * De donde sale el `ActorContext` de cada llamada (7.4). Ausente, se usa uno
   * que igual registra AGENT pero sin nombre de cliente: el transporte que sabe
   * quien se conecto pasa el suyo (ver `contextoDeAgente`).
   */
  contexto?: FabricaDeContexto;
  /**
   * Donde se escribe el log estructurado de la 11.1. Ausente, no se escribe
   * nada: instrumentar no puede obligar a configurar, y una prueba que no mira
   * el log no tiene por que inyectar uno.
   */
  logger?: Logger;
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
  const entorno: EntornoMcp = {
    contexto: opciones.contexto ?? CONTEXTO_MCP_POR_DEFECTO,
    logger: opciones.logger ?? LOGGER_NULO,
  };

  // Las ONCE reciben el entorno, tambien las cinco de lectura. Antes solo lo
  // recibian las seis que escriben, porque `contexto` servia unicamente para
  // auditar y las lecturas no se auditan (7.4). Con la 11.1 la asimetria se
  // termina: una lectura tambien se registra, y una resolucion por nombre —que
  // ocurre igual en list_tasks que en move_task— tiene que quedar correlacionada
  // con la invocacion que la pidio. Es el "motivo para recibirlo" que
  // `domain/actor.ts` dejaba anotado.
  return [
    definirListBoards(port, entorno),
    definirGetBoard(port, entorno),
    definirCreateBoard(port, entorno),
    definirCreateColumn(port, entorno),
    definirListTasks(port, entorno),
    definirSearchTasks(port, entorno),
    definirGetTask(port, entorno),
    definirCreateTask(port, entorno),
    definirUpdateTask(port, entorno),
    definirMoveTask(port, entorno),
    definirDeleteTask(port, entorno, politica),
  ];
}
