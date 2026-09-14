import {
  crearCorePort,
  esUuid,
  esVencida,
  isDomainError,
  LIMITE_PAGINA_MAXIMO,
  type ColumnWithTaskCount,
  type Task,
} from "@taskman/core";

import { hayFiltros, type Filtros } from "./filtros";

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
  /**
   * No la pinta la TARJETA —la 9.3 le da titulo, prioridad y fecha, y nada mas—
   * sino el PANEL de detalle, que la edita. Se CARGA con cada tarea porque el
   * panel se resuelve sobre lo que la pagina ya cargo (ver `ubicarEnVista`) y no
   * con una consulta propia: traerla aca cuesta una columna mas en un SELECT que
   * ya se hace, y no traerla costaria una consulta por apertura de panel. Lo que
   * NO hace es cruzar al navegador: `paraLaPantalla` la quita antes de pasarle
   * las columnas a `ColumnList`, y solo viaja la de la tarea abierta.
   */
  description: string | null;
  priority: Task["priority"];
  dueDate: Date | null;
  /**
   * Lo calcula el SERVIDOR, con la definicion del nucleo (`esVencida`), y no el
   * componente: la regla mira la key de la columna ademas de la fecha, y esa es
   * la mitad que se pierde cuando alguien la rehace mirando solo la tarjeta.
   */
  vencida: boolean;
  /**
   * La `position` REAL en su columna: el entero denso 0..n-1 del ADR-004, tal
   * como esta en la base.
   *
   * NO ES EL INDICE EN `tasks`, y la diferencia es el motivo de que este campo
   * exista: con un filtro puesto, `tasks` es un SUBCONJUNTO de la columna, asi
   * que la tercera tarjeta de la pantalla puede ser la position 7. El arrastre
   * necesita la real para traducir donde se solto una tarjeta a lo que entiende
   * `TaskService.move` (ver `lib/orden.ts`), y sin este campo esa traduccion no
   * tiene con que hacerse: el cliente no puede ver las tareas que el filtro
   * escondio, pero si puede saber en que hueco caen las que si ve.
   */
  position: number;
}

export interface ColumnaEnTablero {
  id: string;
  name: string;
  key: string;
  /**
   * Recuento REAL de la columna, agregado en la base y SIN FILTRAR. Sigue siendo
   * el total aunque haya filtro: es el numero que dice cuanto esconde el filtro,
   * y es la razon por la que este dato viene de la base y no de `tasks.length`.
   */
  taskCount: number;
  /** Las que se muestran. Con filtro, solo las que lo cumplen. */
  tasks: TareaEnTablero[];
  /**
   * Cuantas tareas de la columna no se trajeron POR EL TOPE DE PAGINA. Sin filtro
   * es exacto (`taskCount - tasks.length`). CON FILTRO es 0 y no se puede
   * calcular: la resta daria las que quito el FILTRO, que no es lo mismo y seria
   * una mentira visible en cada columna filtrada. El corte lo dice `recorte`.
   */
  omitidas: number;
  /**
   * El listado se corto por el tope de pagina (`LIMITE_PAGINA_MAXIMO`). Sale del
   * cursor del nucleo, que es la respuesta autoritativa y vale igual con filtro y
   * sin el. En uso personal es falso siempre.
   */
  recorte: boolean;
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
  /** El tablero que se muestra, o `undefined` si no hay ninguno que mostrar. */
  actual: TableroEnPantalla | undefined;
  /**
   * La URL pidio un tablero y NO EXISTE: se borro, o el enlace esta mal copiado.
   * `actual` es `undefined` y la pagina lo dice, en vez de mostrar otro en su
   * lugar (ver `page.tsx`). Falso cuando no se pidio ninguno.
   */
  inexistente: boolean;
}

/**
 * Lo que la pagina necesita: la lista de tableros para la barra y el tablero
 * activo entero.
 *
 * CUAL ES EL ACTIVO: el que nombra la URL (`?tablero=<id>`, ver
 * `leerTableroElegido`). Sin parametro, el primero del listado, que el nucleo
 * ordena por nombre ascendente (`ORDEN_BOARD` en `board-repository.ts`): era la
 * unica regla cuando no se podia cambiar de tablero y sigue siendo la del `/` a
 * secas, porque es la unica que no inventa nada —la misma que veria quien llama a
 * GET /api/boards sin cursor—.
 *
 * EL PEDIDO SE CARGA POR ID, NO SE BUSCA EN EL LISTADO. El listado pagina, y un
 * tablero que no entro en la pagina de la barra sigue existiendo y se tiene que
 * poder abrir por su enlace; lo unico que no tendra es la marca en la barra, que
 * ya dice "y mas sin mostrar".
 */
export async function cargarVista(
  hoy: Date,
  filtros: Filtros,
  pedido: string | undefined,
): Promise<VistaDelTablero> {
  const listado = await taskman.listBoards({ limit: LIMITE_PAGINA_MAXIMO });
  const primero = listado.items[0];

  // El mismo metodo que sirve GET /api/boards/{id}: columnas EN ORDEN y el
  // recuento de cada una agregado en la base, no contado sobre lo que se trajo.
  const detalle =
    pedido !== undefined
      ? await cargarPedido(pedido)
      : primero === undefined
        ? undefined
        : await taskman.getBoardWithTaskCounts(primero.id);

  const tableros = listado.items.map((tablero) => ({
    id: tablero.id,
    name: tablero.name,
    activo: tablero.id === detalle?.id,
  }));

  // Mismo criterio que `omitidas` en una columna: el listado pagina, asi que si
  // corto hay que decirlo en vez de mostrar una lista que parece completa.
  const tablerosOmitidos = listado.nextCursor === null ? 0 : 1;

  if (detalle === undefined) {
    return { tableros, tablerosOmitidos, actual: undefined, inexistente: pedido !== undefined };
  }

  const columns = await Promise.all(
    detalle.columns.map((columna) => cargarColumna(columna, hoy, filtros)),
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
    inexistente: false,
  };
}

/**
 * El tablero que nombra la URL, o `undefined` si no hay ninguno con ese id.
 *
 * UN VALOR QUE NO ES UN UUID NO LLEGA A LA BASE. La columna es `uuid`, y
 * `?tablero=cualquier-cosa` convertido en consulta no daria "no existe": daria un
 * error del driver y un 500. Es texto tecleado en la barra de direcciones, no un
 * fallo del sistema.
 *
 * Y BOARD_NOT_FOUND ES UNA RESPUESTA, NO UN FALLO: es el enlace a un tablero que
 * alguien borro. Cualquier otro error sigue subiendo, porque ese si lo es.
 */
async function cargarPedido(pedido: string) {
  if (!esUuid(pedido)) {
    return undefined;
  }

  try {
    return await taskman.getBoardWithTaskCounts(pedido.trim());
  } catch (error: unknown) {
    if (isDomainError(error) && error.code === "BOARD_NOT_FOUND") {
      return undefined;
    }

    throw error;
  }
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
  filtros: Filtros,
): Promise<ColumnaEnTablero> {
  /**
   * LOS FILTROS VAN EN LA CONSULTA, no en un `.filter()` sobre el resultado. Es
   * la diferencia entre pedir tres tareas y pedir doscientas para esconder ciento
   * noventa y siete, y ademas es lo unico que hace que el filtro y la marca de
   * vencida no puedan discrepar: `overdue` lo resuelve el nucleo con la misma
   * `COLUMNA_TERMINAL` que usa `esVencida` unas lineas mas abajo.
   *
   * `priority` se omite cuando no hay ninguna elegida. Mandar un array vacio
   * seria inofensivo —el nucleo lo ignora, `length > 0`— pero pasarlo igual
   * dejaria a esta funcion apoyada en ese detalle del repositorio.
   */
  const pagina = await taskman.listTasks({
    columnId: columna.id,
    orderBy: "position",
    limit: LIMITE_PAGINA_MAXIMO,
    ...(filtros.prioridades.length === 0 ? {} : { priority: filtros.prioridades }),
    ...(filtros.vencidas ? { overdue: true } : {}),
  });

  const filtrando = hayFiltros(filtros);

  return {
    id: columna.id,
    name: columna.name,
    key: columna.key,
    taskCount: columna.taskCount,
    tasks: pagina.items.map((tarea) => ({
      id: tarea.id,
      title: tarea.title,
      description: tarea.description,
      priority: tarea.priority,
      dueDate: tarea.dueDate,
      vencida: esVencida(tarea, columna, hoy),
      position: tarea.position,
    })),
    // Ver `ColumnaEnTablero.omitidas`: la resta solo significa algo sin filtro.
    omitidas: filtrando ? 0 : Math.max(0, columna.taskCount - pagina.items.length),
    recorte: pagina.nextCursor !== null,
  };
}

// --- Lo que cruza al cliente -------------------------------------------------

/**
 * Una tarjeta tal como la ve el NAVEGADOR. Es `TareaEnTablero` MENOS
 * `description`, y esa resta es todo el motivo de que este tipo exista.
 *
 * Hasta este paso las tarjetas las dibujaba un componente de SERVIDOR, asi que
 * `description` se usaba para renderizar y no viajaba: lo unico que cruzaba era
 * la tarea ABIERTA en el panel, por `TaskEditor`. El arrastre mueve el limite
 * —`ColumnList` y todo lo que cuelga de el pasan a cliente— y con el se lleva
 * las PROPIEDADES: React serializa en la carga RSC todo lo que se le pasa a un
 * componente de cliente, lo lea o no.
 *
 * O sea que sin esta proyeccion, abrir el tablero mandaria al navegador la
 * descripcion completa de cada tarea del tablero para no pintar ninguna. Con
 * ella se sigue cumpliendo lo que decia el panel: abrir una tarea manda ESA
 * tarea al cliente, no el tablero entero.
 */
export type TarjetaEnPantalla = Omit<TareaEnTablero, "description">;

/** Una columna con sus tarjetas ya proyectadas. */
export interface ColumnaEnPantalla extends Omit<ColumnaEnTablero, "tasks"> {
  tasks: TarjetaEnPantalla[];
}

/**
 * Proyecta las columnas para pasarselas al `ColumnList` de cliente.
 *
 * Es una vuelta mas sobre el tablero entero en cada render y vale lo que cuesta:
 * el tablero ya se recorrio dos veces para armarlo, y lo que se ahorra es ancho
 * de banda en cada carga y en cada revalidacion.
 */
export function paraLaPantalla(columnas: readonly ColumnaEnTablero[]): ColumnaEnPantalla[] {
  return columnas.map((columna) => ({
    ...columna,
    tasks: columna.tasks.map(({ description: _description, ...tarjeta }) => tarjeta),
  }));
}

/** Una tarea localizada dentro de la vista, con la columna donde vive. */
export interface TareaUbicada {
  tarea: TareaEnTablero;
  columna: ColumnaEnTablero;
}

/**
 * Busca una tarea POR ID DENTRO DE LO QUE LA PAGINA YA CARGO, para el panel de
 * detalle. No consulta nada.
 *
 * ES A PROPOSITO QUE NO CONSULTE, y tiene tres consecuencias que valen las tres:
 *
 *   - Ni una consulta mas por apertura de panel. Los cuatro campos que el panel
 *     edita ya vienen en `TareaEnTablero`.
 *   - Un id de OTRO tablero no abre nada. Es el mismo agujero que CLAUDE.md
 *     anota para `ubicarTarea` del borde MCP —"un id valido de OTRO tablero se
 *     acepta"— y aca no puede existir, porque el ambito de la busqueda ES el
 *     tablero que se esta mostrando. No es que se compruebe: es que no hay donde
 *     buscar fuera.
 *   - Un id inexistente, o el de una tarea que se acaba de borrar, devuelve
 *     `undefined` y la pagina dibuja el tablero sin panel. Ni 404 ni 500: un
 *     enlace viejo en la barra de direcciones no es un error del sistema.
 *
 * El precio, que hoy no se paga: una tarea que quedo fuera por el tope de pagina
 * de su columna (`omitidas`) no se puede abrir. En uso personal `omitidas` es
 * cero siempre; el dia que no lo sea, el arreglo es consultarla por id y
 * comprobar que su `boardId` es el del tablero mostrado, no ampliar el tope.
 */
export function ubicarEnVista(
  tablero: TableroEnPantalla,
  taskId: string | undefined,
): TareaUbicada | undefined {
  if (taskId === undefined) {
    return undefined;
  }

  for (const columna of tablero.columns) {
    const tarea = columna.tasks.find((candidata) => candidata.id === taskId);

    if (tarea !== undefined) {
      return { tarea, columna };
    }
  }

  return undefined;
}
