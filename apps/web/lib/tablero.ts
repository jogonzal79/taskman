import {
  crearCorePort,
  esVencida,
  LIMITE_PAGINA_MAXIMO,
  type ColumnWithTaskCount,
  type Task,
} from "@taskman/core";

/**
 * La carga del tablero para la UI de la 9.1: "La carga inicial del tablero se
 * hace en un Server Component invocando el nucleo directamente, sin pasar por
 * HTTP".
 *
 * Vive en `lib/` y no dentro de `page.tsx` por la misma razon que `lib/tareas.ts`
 * no vive dentro de un Route Handler: lo que hace no es renderizar, es traducir
 * entre el nucleo y lo que la pantalla necesita. Cuando F3 siga —filtros,
 * seleccion de tablero— el que cambia es este archivo y no los componentes.
 *
 * NO IMPORTA PRISMA, ni directa ni indirectamente por su cuenta: pide un
 * `CorePort`, que es el mismo camino que usan los Route Handlers. La regla de la
 * 3.2 vale igual para este adaptador que para el REST.
 *
 * OJO con el grafo: este modulo arrastra el nucleo entero y por lo tanto `pg`.
 * Solo puede colgar de un Server Component. Nada de lo que importe
 * `instrumentation.ts` puede llegar aca (ver el comentario de `lib/config.ts`).
 */

const taskman = crearCorePort();

/** Una tarea ya resuelta para pintar: la marca de vencida viene calculada. */
export interface TareaEnTablero {
  id: string;
  title: string;
  priority: Task["priority"];
  dueDate: Date | null;
  /**
   * Lo calcula el SERVIDOR, con la definicion del nucleo (`esVencida`), y no el
   * componente: la regla mira la key de la columna ademas de la fecha, y esa es
   * la mitad que se pierde cuando alguien la rehace mirando solo la tarjeta.
   */
  vencida: boolean;
}

export interface ColumnaEnTablero {
  id: string;
  name: string;
  key: string;
  /** Recuento REAL de la columna, agregado en la base. Ver `omitidas`. */
  taskCount: number;
  tasks: TareaEnTablero[];
  /**
   * Cuantas tareas de la columna no se trajeron. El listado del nucleo pagina
   * (`LIMITE_PAGINA_MAXIMO`), asi que una columna con mas tareas que el tope se
   * renderiza incompleta; decirlo es mejor que mostrar un recuento que no cuadra
   * con lo que se ve. En uso personal esto es cero siempre.
   */
  omitidas: number;
}

export interface TableroEnPantalla {
  id: string;
  name: string;
  taskCount: number;
  columns: ColumnaEnTablero[];
}

/** Una entrada de la barra lateral. Solo nombre y si es la que se esta viendo. */
export interface TableroEnBarra {
  id: string;
  name: string;
  activo: boolean;
}

export interface VistaDelTablero {
  /** Todos los tableros, en el orden del listado. Vacio si no hay ninguno. */
  tableros: TableroEnBarra[];
  /** Cuantos tableros no entraron en la pagina. Cero salvo en lo absurdo. */
  tablerosOmitidos: number;
  /** El tablero que se muestra, o `undefined` si no hay ninguno. */
  actual: TableroEnPantalla | undefined;
}

/**
 * Lo que la pagina necesita: la lista de tableros para la barra y el tablero
 * activo entero.
 *
 * CUAL ES EL ACTIVO: el primero del listado, que el nucleo ordena por nombre
 * ascendente (`ORDEN_BOARD` en `board-repository.ts`). F3 todavia no tiene
 * navegacion entre tableros —la barra lateral los lista y marca el actual, pero
 * no se puede cambiar— asi que hace falta una regla y esta es la unica que no
 * inventa nada: es la misma que veria quien llama a GET /api/boards sin cursor.
 */
export async function cargarVista(hoy: Date): Promise<VistaDelTablero> {
  const listado = await taskman.listBoards({ limit: LIMITE_PAGINA_MAXIMO });
  const activo = listado.items[0];

  const tableros = listado.items.map((tablero) => ({
    id: tablero.id,
    name: tablero.name,
    activo: tablero.id === activo?.id,
  }));

  // Mismo criterio que `omitidas` en una columna: el listado pagina, asi que si
  // corto hay que decirlo en vez de mostrar una lista que parece completa.
  const tablerosOmitidos = listado.nextCursor === null ? 0 : 1;

  if (activo === undefined) {
    return { tableros, tablerosOmitidos, actual: undefined };
  }

  // El mismo metodo que sirve GET /api/boards/{id}: columnas EN ORDEN y el
  // recuento de cada una agregado en la base, no contado sobre lo que se trajo.
  const detalle = await taskman.getBoardWithTaskCounts(activo.id);

  const columns = await Promise.all(
    detalle.columns.map((columna) => cargarColumna(columna, hoy)),
  );

  return {
    tableros,
    tablerosOmitidos,
    actual: {
      id: detalle.id,
      name: detalle.name,
      taskCount: detalle.taskCount,
      columns,
    },
  };
}

/**
 * Una consulta POR COLUMNA y no una sola por tablero. Con una sola habria que
 * reagrupar en memoria, y sobre todo el tope de pagina se repartiria entre todas
 * las columnas: la ultima columna de un tablero grande saldria vacia sin que nada
 * lo dijera. Asi el tope es por columna y el corte es observable (`omitidas`).
 */
async function cargarColumna(
  columna: ColumnWithTaskCount,
  hoy: Date,
): Promise<ColumnaEnTablero> {
  const pagina = await taskman.listTasks({
    columnId: columna.id,
    orderBy: "position",
    limit: LIMITE_PAGINA_MAXIMO,
  });

  return {
    id: columna.id,
    name: columna.name,
    key: columna.key,
    taskCount: columna.taskCount,
    tasks: pagina.items.map((tarea) => ({
      id: tarea.id,
      title: tarea.title,
      priority: tarea.priority,
      dueDate: tarea.dueDate,
      vencida: esVencida(tarea, columna, hoy),
    })),
    omitidas: Math.max(0, columna.taskCount - pagina.items.length),
  };
}
