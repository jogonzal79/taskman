import { SCOPES, type Scope } from "../domain/api-key";
import { LOGGER_NULO, type Logger } from "../domain/logger";
import { CONTEXTO_MCP_POR_DEFECTO, type FabricaDeContexto } from "./contexto";
import type { EntornoMcp } from "./llamada";
import { POLITICA_DESTRUCTIVA_POR_DEFECTO, type PoliticaDestructiva } from "./politica";
import type { TaskManagerPort } from "./port";
import type { McpToolDefinition } from "./tool";
import { definirCreateBoard } from "./tools/create-board";
import { definirCreateColumn } from "./tools/create-column";
import { definirCreateTask } from "./tools/create-task";
import { definirDeleteTask } from "./tools/delete-task";
import { definirGetBoard } from "./tools/get-board";
import { definirGetTask } from "./tools/get-task";
import { definirListBoards } from "./tools/list-boards";
import { definirListTasks } from "./tools/list-tasks";
import { definirMoveTask } from "./tools/move-task";
import { definirSearchTasks } from "./tools/search-tasks";
import { definirUpdateTask } from "./tools/update-task";

export interface OpcionesRegistro {
  /**
   * Los scopes de la 7.2 de la clave que va a usar estas herramientas. Se
   * devuelven SOLO las que exigen uno de ellos, y lo que no se devuelve no se
   * registra: es el filtrado en el listado que pide la 8.1.
   *
   * OBLIGATORIO y sin valor por defecto, por lo mismo que `scope` en cada
   * definicion. Con un defecto, el montaje que se olvide de pasarlo —el de /mcp,
   * que todavia no existe— le ofreceria las once a cualquier clave; asi, no
   * compila. Quien de verdad no tiene clave que consultar pasa `SCOPES` y queda
   * escrito (ver `apps/mcp-stdio/src/index.ts`).
   */
  scopes: readonly Scope[];
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
 * DOS FILTROS INDEPENDIENTES, y ninguno toca lo que decide el otro:
 *
 * - Los SCOPES de la clave (7.2) deciden que herramientas hay. La que exige un
 *   scope que la clave no tiene NO SE DEVUELVE.
 * - MCP_DESTRUCTIVE_POLICY (8.3.2) decide si delete_task se ofrece. Con `deny`
 *   viene en la lista con `anunciada: false` y un handler que explica por que no
 *   se puede, y el transporte la registra deshabilitada.
 *
 * Uno omite y el otro marca, y por eso no pueden deshacerse: el de scopes nunca
 * escribe `anunciada` y el de politica nunca saca nada de la lista. Si los dos
 * compartieran el campo, alcanzaria un `anunciada: tieneElScope` para que una
 * clave con `delete` volviera a ver delete_task bajo `deny`.
 *
 * Por que uno omite y el otro no: la politica es del SERVIDOR y vale para
 * cualquier clave, asi que "deshabilitada" dice la verdad, y omitirla daria
 * "herramienta desconocida", que no distingue una politica de un error. Para una
 * clave sin el scope, en cambio, la herramienta no existe: marcarla la
 * presentaria como algo que el servidor podria prender.
 *
 * El orden es el del catalogo de la 8.2 —tableros, columnas, tareas— porque es
 * el orden en que las ve el agente al listar herramientas, y leerlas de lo
 * general a lo particular ayuda a que elija la correcta. Filtrar lo conserva.
 */
export function crearHerramientas(
  port: TaskManagerPort,
  opciones: OpcionesRegistro,
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
  const catalogo = [
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

  const disponibles = catalogo.filter((herramienta) => opciones.scopes.includes(herramienta.scope));

  // UN CATALOGO VACIO NO SE ARMA. No porque sea inseguro —no podria hacer nada—
  // sino porque el SDK no lo sirve como vacio: un `McpServer` sin ninguna
  // herramienta registrada no declara la capacidad `tools`, y tools/list
  // responde -32601 "Method not found" (medido con el SDK 1.30.0). Un cliente
  // lee eso como un servidor sin soporte de herramientas, no como "tu clave no
  // alcanza". Ninguna clave valida llega aca: la base rechaza una sin scopes
  // (`api_key_scopes_nonempty`) y cada scope de la 7.2 tiene al menos una
  // herramienta en la 8.2. Lo que queda es un montaje que pasa la lista vacia
  // por error, y ese tiene que fallar al construir, no en el primer mensaje.
  //
  // Mira lo que se DEVUELVE y no lo que se anuncia: una clave con solo `delete`
  // bajo `deny` recibe delete_task marcada, el transporte la registra apagada y
  // tools/list responde `[]`, que el SDK sirve bien. Si contara la politica,
  // `deny` decidiria si un servidor arranca, y los filtros dejarian de ser
  // independientes.
  if (disponibles.length === 0) {
    throw new Error(
      `Ninguna herramienta MCP admite los scopes [${opciones.scopes.join(", ")}]: ` +
        `cada una exige uno de ${SCOPES.join(", ")} (8.2), y un servidor sin herramientas no se monta.`,
    );
  }

  return disponibles;
}
