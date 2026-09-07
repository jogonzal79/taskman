import { DomainError } from "../domain/errors.js";
import type { BoardDetail, Column, ListTasksQuery, Page, Task } from "../domain/types.js";
import { LIMITE_PAGINA_MAXIMO } from "../domain/types.js";
import type { TaskManagerPort } from "./port.js";
import type { Candidato } from "./resolve.js";
import { esUuid, resolverReferencia } from "./resolve.js";

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
): Promise<BoardDetail> {
  if (esUuid(referencia)) {
    return port.getBoard(referencia.trim());
  }

  const tableros = await recolectar((cursor) =>
    port.listBoards(cursor === undefined ? { limit: LIMITE_PAGINA_MAXIMO } : { limit: LIMITE_PAGINA_MAXIMO, cursor }),
  );

  const elegido = resolverReferencia(
    referencia,
    tableros.map((tablero) => ({ id: tablero.id, label: tablero.name })),
    {
      entidad: "tablero",
      plural: "tableros",
      genero: "m",
      campo: "board",
      etiqueta: "name",
      notFound: "BOARD_NOT_FOUND",
    },
  );

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
export function resolverColumnaDelTablero(tablero: BoardDetail, referencia: string): Column {
  const candidatos: Candidato[] = tablero.columns.map((columna) => ({
    id: columna.id,
    label: columna.name,
    alias: [columna.key, columna.key.replace(/_/g, " ")],
    extra: { key: columna.key },
  }));

  const elegida = resolverReferencia(referencia, candidatos, {
    entidad: "columna",
    plural: "columnas",
    genero: "f",
    campo: "column",
    etiqueta: "name",
    notFound: "COLUMN_NOT_FOUND",
    scope: { board_id: tablero.id, board_name: tablero.name },
  });

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
  columnId?: string,
): Promise<string> {
  if (esUuid(referencia)) {
    return referencia.trim();
  }

  const base: ListTasksQuery = {
    boardId: tablero.id,
    limit: LIMITE_PAGINA_MAXIMO,
    ...(columnId === undefined ? {} : { columnId }),
  };
  const tareas = await recolectar((cursor) =>
    port.listTasks(cursor === undefined ? base : { ...base, cursor }),
  );

  const keyDeColumna = new Map(tablero.columns.map((columna) => [columna.id, columna.key]));
  const candidatos: Candidato[] = tareas.map((tarea: Task) => ({
    id: tarea.id,
    label: tarea.title,
    // La 6.4 fija esta forma para `details.candidates`: id, titulo y columna.
    // Sin la columna, dos tareas homonimas son indistinguibles para el agente.
    extra: { column_id: tarea.columnId, column_key: keyDeColumna.get(tarea.columnId) ?? null },
  }));

  const elegida = resolverReferencia(referencia, candidatos, {
    entidad: "tarea",
    plural: "tareas",
    genero: "f",
    campo: "task",
    etiqueta: "title",
    notFound: "TASK_NOT_FOUND",
    scope: {
      board_id: tablero.id,
      board_name: tablero.name,
      ...(columnId === undefined ? {} : { column_id: columnId }),
    },
  });

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
