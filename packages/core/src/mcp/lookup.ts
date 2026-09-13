import { DomainError } from "../domain/errors";
import type { BoardDetail, Column, ListTasksQuery, Page, Task } from "../domain/types";
import { LIMITE_PAGINA_MAXIMO } from "../domain/types";
import type { TaskManagerPort } from "./port";
import type { Llamada } from "./llamada";
import type { AmbitoResolucion, Candidato } from "./resolve";
import { esUuid, resolverReferencia } from "./resolve";

/**
 * Las tres resoluciones concretas —tablero, columna, tarea— sobre el puerto.
 *
 * La REGLA vive en `resolve.ts` y es una sola; aca esta unicamente de donde
 * sale el ambito de cada entidad. Separarlo asi es lo que hace que "una
 * coincidencia procede, dos son AMBIGUOUS_MATCH" no pueda divergir entre
 * herramientas.
 */

/**
 * Tope de paginas al enumerar un ambito. No es un limite de negocio: es un
 * seguro contra un cursor que no avanza. A 200 filas por pagina son 10 000
 * tareas, muy por encima de un tablero personal, que es el escenario del MVP.
 */
const MAXIMO_PAGINAS = 50;

export async function recolectar<T>(
  leer: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAXIMO_PAGINAS; pagina += 1) {
    const actual = await leer(cursor);
    items.push(...actual.items);
    if (actual.nextCursor === null) {
      break;
    }
    cursor = actual.nextCursor;
  }

  return items;
}

const AMBITO_TABLERO: AmbitoResolucion = {
  entidad: "tablero",
  plural: "tableros",
  genero: "m",
  campo: "board",
  etiqueta: "name",
  entity: "board",
  notFound: "BOARD_NOT_FOUND",
};

/**
 * Resuelve el tablero y lo devuelve CON sus columnas.
 *
 * Que devuelva el detalle y no un id no es comodidad: toda herramienta que
 * resuelve un tablero necesita despues las columnas —para resolver la columna
 * destino, o para poner la key de cada tarea en la respuesta— y hacerlo en un
 * solo paso evita que cada herramienta decida por su cuenta cuando releerlas.
 */
export async function cargarTablero(
  port: TaskManagerPort,
  referencia: string,
  llamada: Llamada,
): Promise<BoardDetail> {
  // Con un UUID no hace falta enumerar el ambito: la 8.3.1 dice que se usa
  // directamente. Se sigue llamando a `resolverReferencia` igual, con la lista
  // vacia —que en ese camino ni se mira— para que TODA resolucion pase por el
  // mismo punto y deje su linea. Cortar aca ahorraria una llamada y perderia
  // justo el dato que distingue a un agente que encadena por id de uno que
  // adivina nombres.
  const candidatos = esUuid(referencia)
    ? []
    : (
        await recolectar((cursor) =>
          port.listBoards(cursor === undefined ? { limit: LIMITE_PAGINA_MAXIMO } : { limit: LIMITE_PAGINA_MAXIMO, cursor }),
        )
      ).map((tablero) => ({ id: tablero.id, label: tablero.name }));

  const elegido = resolverReferencia(referencia, candidatos, AMBITO_TABLERO, llamada);

  return port.getBoard(elegido.id);
}

/**
 * Resuelve una columna dentro de un tablero ya cargado. Sin E/S: las columnas
 * vienen en el detalle del tablero.
 *
 * La key es alias de coincidencia exacta ademas del nombre, porque es como los
 * agentes nombran las columnas (`TODO`, `IN_PROGRESS`). Se agrega tambien la
 * key con espacios en lugar de guiones bajos: "IN PROGRESS" es lo que escribe
 * un humano y lo que aparece en los ejemplos de la 8.5.
 */
export function resolverColumnaDelTablero(
  tablero: BoardDetail,
  referencia: string,
  llamada: Llamada,
): Column {
  const candidatos: Candidato[] = tablero.columns.map((columna) => ({
    id: columna.id,
    label: columna.name,
    alias: [columna.key, columna.key.replace(/_/g, " ")],
    extra: { key: columna.key },
  }));

  const elegida = resolverReferencia(
    referencia,
    candidatos,
    {
      entidad: "columna",
      plural: "columnas",
      genero: "f",
      campo: "column",
      etiqueta: "name",
      entity: "column",
      notFound: "COLUMN_NOT_FOUND",
      scope: { board_id: tablero.id, board_name: tablero.name },
    },
    llamada,
  );

  const columna = tablero.columns.find((candidata) => candidata.id === elegida.id);
  if (columna !== undefined) {
    return columna;
  }

  // Solo se llega aca con un id que tiene forma de UUID pero no es de este
  // tablero. Es exactamente COLUMN_NOT_IN_BOARD, y decirlo asi le ahorra al
  // agente descubrirlo recien cuando falle la escritura.
  throw new DomainError(
    "COLUMN_NOT_IN_BOARD",
    `La columna ${elegida.id} no pertenece al tablero "${tablero.name}".`,
    {
      details: { column: referencia, column_id: elegida.id, board_id: tablero.id },
      hint: `Las columnas de este tablero son: ${tablero.columns.map((c) => c.key).join(", ")}.`,
    },
  );
}

/** Las tareas del ambito como candidatos de resolucion. */
async function candidatosDeTareas(
  port: TaskManagerPort,
  tablero: BoardDetail,
  columnId: string | undefined,
): Promise<Candidato[]> {
  const base: ListTasksQuery = {
    boardId: tablero.id,
    limit: LIMITE_PAGINA_MAXIMO,
    ...(columnId === undefined ? {} : { columnId }),
  };
  const tareas = await recolectar((cursor) =>
    port.listTasks(cursor === undefined ? base : { ...base, cursor }),
  );

  const keyDeColumna = new Map(tablero.columns.map((columna) => [columna.id, columna.key]));
  return tareas.map((tarea: Task) => ({
    id: tarea.id,
    label: tarea.title,
    // La 6.4 fija esta forma para `details.candidates`: id, titulo y columna.
    // Sin la columna, dos tareas homonimas son indistinguibles para el agente.
    extra: { column_id: tarea.columnId, column_key: keyDeColumna.get(tarea.columnId) ?? null },
  }));
}

/**
 * Resuelve una tarea por titulo dentro del tablero, opcionalmente acotada a una
 * columna.
 *
 * El ambito es SIEMPRE el tablero, nunca global: por eso un titulo que existe
 * en otro tablero no se encuentra aca, aunque el nombre del tablero indicado
 * sea correcto. Es la razon por la que `board` es obligatorio en move_task
 * cuando la tarea se identifica por titulo (8.4).
 */
export async function resolverTareaDelTablero(
  port: TaskManagerPort,
  tablero: BoardDetail,
  referencia: string,
  llamada: Llamada,
  columnId?: string,
): Promise<string> {
  // Mismo criterio que en `cargarTablero`: con un UUID no se enumera el ambito,
  // pero la resolucion pasa igual por el unico punto que la registra.
  const candidatos = esUuid(referencia)
    ? []
    : await candidatosDeTareas(port, tablero, columnId);

  const elegida = resolverReferencia(
    referencia,
    candidatos,
    {
      entidad: "tarea",
      plural: "tareas",
      genero: "f",
      campo: "task",
      etiqueta: "title",
      entity: "task",
      notFound: "TASK_NOT_FOUND",
      scope: {
        board_id: tablero.id,
        board_name: tablero.name,
        ...(columnId === undefined ? {} : { column_id: columnId }),
      },
    },
    llamada,
  );

  return elegida.id;
}

/**
 * Orden completo de una columna, leido de la base.
 *
 * `move` ya lo devuelve en `affectedColumns` (5.1); `create` no, y la respuesta
 * de la 8.5 lo necesita para que el agente encadene sin volver a consultar.
 */
export async function ordenDeColumna(
  port: TaskManagerPort,
  boardId: string,
  columnId: string,
): Promise<string[]> {
  const base: ListTasksQuery = { boardId, columnId, orderBy: "position", limit: LIMITE_PAGINA_MAXIMO };
  const tareas = await recolectar((cursor) =>
    port.listTasks(cursor === undefined ? base : { ...base, cursor }),
  );
  return tareas.map((tarea) => tarea.id);
}

/**
 * Resuelve a la vez la tarea y su tablero, porque una cosa depende de la otra.
 *
 * Con `board` el ambito es ese tablero. Sin `board`, `task` tiene que ser un id
 * y el tablero sale de la propia tarea: hace falta igual, porque toda columna
 * que la herramienta nombre —la destino de un move, la actual de un get— se
 * resuelve CONTRA las columnas del tablero, y sin cargarlas la resolucion
 * dejaria de ser la misma en los dos caminos.
 *
 * Lo comparten move_task, get_task y update_task: es la unica forma de que
 * "un titulo solo se resuelve dentro de un tablero" signifique lo mismo en las
 * tres.
 */
export async function ubicarTarea(
  port: TaskManagerPort,
  referenciaTarea: string,
  referenciaTablero: string | undefined,
  llamada: Llamada,
): Promise<{ tablero: BoardDetail; taskId: string }> {
  if (referenciaTablero !== undefined) {
    const tablero = await cargarTablero(port, referenciaTablero, llamada);
    return {
      tablero,
      taskId: await resolverTareaDelTablero(port, tablero, referenciaTarea, llamada),
    };
  }

  if (!esUuid(referenciaTarea)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Falta `board`: un titulo solo se resuelve dentro de un tablero.",
      {
        details: { field: "board", task: referenciaTarea },
        hint: "Volve a llamar indicando board con el nombre o el id del tablero, o pasa el id de la tarea en task.",
      },
    );
  }

  const tarea = await port.getTask(referenciaTarea.trim());
  return { tablero: await port.getBoard(tarea.boardId), taskId: tarea.id };
}

/**
 * Todas las tareas del tablero, sin filtrar. Es lo que necesita get_board para
 * decir cuantas tareas tiene cada columna sin una consulta por columna.
 */
export async function tareasDelTablero(port: TaskManagerPort, boardId: string): Promise<Task[]> {
  const base: ListTasksQuery = { boardId, orderBy: "position", limit: LIMITE_PAGINA_MAXIMO };
  return recolectar((cursor) =>
    port.listTasks(cursor === undefined ? base : { ...base, cursor }),
  );
}

/**
 * Los tableros indicados, con sus columnas, indexados por id.
 *
 * Lo usa search_tasks, que puede devolver coincidencias de varios tableros a la
 * vez: sin el nombre del tablero y la key de la columna, una busqueda global
 * devuelve titulos que el agente no puede ubicar ni encadenar. Son tantas
 * lecturas como tableros distintos aparezcan, no como coincidencias haya.
 */
export async function contextoDeTableros(
  port: TaskManagerPort,
  boardIds: Iterable<string>,
): Promise<Map<string, BoardDetail>> {
  const contexto = new Map<string, BoardDetail>();
  for (const boardId of new Set(boardIds)) {
    contexto.set(boardId, await port.getBoard(boardId));
  }
  return contexto;
}
