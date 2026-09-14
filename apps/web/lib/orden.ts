import type { TargetPosition } from "@taskman/core";

/**
 * La aritmetica del arrastre, SEPARADA de React y del DOM.
 *
 * Todo lo que este archivo hace es traducir entre dos modelos del mismo orden:
 *
 *   - EL VISIBLE, que es lo que hay en pantalla. Con un filtro puesto (9.3) una
 *     columna muestra un SUBCONJUNTO de sus tareas, asi que el indice de una
 *     tarjeta en pantalla NO es su `position` en la base.
 *   - EL REAL, que es la secuencia densa 0..n-1 de la columna (ADR-004) y el
 *     unico que entiende `TaskService.move`.
 *
 * Vive en su propio modulo por lo mismo que `lib/prioridad.ts`: lo importa un
 * componente de CLIENTE y el import tiene que poder cruzar sin arrastrar nada
 * detras. `TargetPosition` entra como `import type`, que `verbatimModuleSyntax`
 * borra al compilar, asi que el nucleo no aparece en el bundle del navegador.
 *
 * Y esta aparte de los componentes por una segunda razon, que es la que decide:
 * estas cinco funciones son PURAS y se prueban con vitest sin navegador y sin
 * base (`test/orden.test.ts`). La traduccion visible->real es lo mas facil de
 * equivocar de todo el paso —se equivoca callada, dejando la tarea una posicion
 * corrida— y es justo lo que una prueba de Playwright mide peor: ahi se ve el
 * resultado, no la cuenta.
 */

/** El orden VISIBLE del tablero: por columna, los ids en el orden en que se pintan. */
export type OrdenVisible = Readonly<Record<string, readonly string[]>>;

/** La columna donde esta una tarea, dentro de un orden visible. */
export function columnaDe(orden: OrdenVisible, taskId: string): string | undefined {
  for (const [columnId, ids] of Object.entries(orden)) {
    if (ids.includes(taskId)) {
      return columnId;
    }
  }

  return undefined;
}

/**
 * Saca una tarea de donde este y la inserta en `columnaDestino` en el indice
 * VISIBLE `indice`.
 *
 * Es la misma semantica de "saca e inserta" que `computeMoveOrder` en el nucleo
 * —el indice se interpreta sobre la lista destino YA SIN la tarea— y eso no es
 * coincidencia: si las dos no coincidieran, lo que se ve al soltar y lo que
 * escribe la transaccion serian distintos SIEMPRE, y la reconciliacion de la 9.2
 * estaria corrigiendo en cada movimiento en vez de solo cuando alguien mas
 * escribio. Un movimiento dentro de la misma columna tampoco es una rama aparte
 * (5.4): sale del mismo saca-e-inserta.
 *
 * El indice se ajusta al tamano en vez de fallar, igual que hace el nucleo.
 */
export function moverEnOrdenVisible(
  orden: OrdenVisible,
  taskId: string,
  columnaDestino: string,
  indice: number,
): OrdenVisible {
  const sinLaTarea: Record<string, readonly string[]> = {};

  for (const [columnId, ids] of Object.entries(orden)) {
    sinLaTarea[columnId] = ids.filter((id) => id !== taskId);
  }

  const destino = [...(sinLaTarea[columnaDestino] ?? [])];
  destino.splice(Math.max(0, Math.min(indice, destino.length)), 0, taskId);
  sinLaTarea[columnaDestino] = destino;

  return sinLaTarea;
}

/**
 * TRADUCE el orden visible al `position` que espera el nucleo. Es el corazon del
 * paso y el unico sitio donde el filtro de la 9.3 y el arrastre se tocan.
 *
 * LA REGLA ES POR VECINO, no por indice: la intencion de soltar una tarjeta en
 * un hueco es "que quede justo antes de la tarjeta que veo debajo", y esa
 * tarjeta SI tiene una `position` real, que el servidor mando con ella. Asi que
 * el indice pedido es la position del vecino de abajo; si no hay ninguno —se
 * solto al final de lo visible— es la del vecino de arriba mas uno; y si la
 * columna se ve vacia no hay ningun ancla y el unico destino honesto es "end".
 *
 * POR QUE NO ALCANZA CON EL INDICE VISIBLE. Con un filtro puesto, una columna
 * con tareas en las positions 0..5 puede estar mostrando solo la 1 y la 4.
 * Soltar una tarjeta entre las dos es el indice visible 1, y mandar 1 la
 * pondria antes de la 1 —o sea en un sitio que el usuario no vio— mientras que
 * la position del vecino de abajo, 4, la deja exactamente donde se la solto.
 * Sin filtro las dos cuentas coinciden, porque entonces el indice visible ES la
 * position; o sea que esto no es un caso especial del filtro sino la cuenta
 * general, de la que el caso sin filtro es la identidad.
 *
 * EL AJUSTE `-1` de la misma columna sale de la semantica de `computeMoveOrder`:
 * el indice se interpreta sobre la columna destino YA SIN la tarea movida, asi
 * que si la tarea salio de una position ANTERIOR a la del ancla, el ancla corre
 * un lugar hacia arriba al quitarla. Entre columnas distintas no hay nada que
 * ajustar, porque la tarea no estaba en la columna destino.
 */
export function posicionParaElNucleo(args: {
  /** El orden visible de la columna destino, YA con la tarea en su sitio. */
  readonly destinoFinal: readonly string[];
  readonly taskId: string;
  /** Si la tarea ya estaba en la columna destino. */
  readonly mismaColumna: boolean;
  /** La `position` REAL de cada tarea visible, tal como la mando el servidor. */
  readonly posiciones: ReadonlyMap<string, number>;
}): TargetPosition {
  const { destinoFinal, taskId, mismaColumna, posiciones } = args;
  const indice = destinoFinal.indexOf(taskId);

  if (indice < 0) {
    // Inalcanzable desde el unico llamador, que arma `destinoFinal` insertandola.
    throw new Error(`La tarea ${taskId} no esta en el orden destino.`);
  }

  const propia = posiciones.get(taskId);
  const ajustar = (position: number): number =>
    mismaColumna && propia !== undefined && propia < position ? position - 1 : position;

  const siguiente = destinoFinal[indice + 1];
  const posicionSiguiente = siguiente === undefined ? undefined : posiciones.get(siguiente);

  if (posicionSiguiente !== undefined) {
    return ajustar(posicionSiguiente);
  }

  const anterior = destinoFinal[indice - 1];
  const posicionAnterior = anterior === undefined ? undefined : posiciones.get(anterior);

  if (posicionAnterior !== undefined) {
    return ajustar(posicionAnterior) + 1;
  }

  // La columna se ve vacia: no hay ancla, y "el final" es lo unico que no
  // inventa un sitio. Es ademas lo que hace el QuickAdd al crear.
  return "end";
}

/**
 * PROYECTA sobre lo visible el orden autoritativo que devolvio el servidor.
 *
 * `MoveResult.affectedColumns` trae el `taskOrder` COMPLETO de la columna,
 * releido de la base dentro de la transaccion. El cliente, con un filtro puesto,
 * solo tiene datos de una parte: de las otras no sabe ni el titulo, asi que no
 * puede pintarlas. Quedarse con la interseccion es lo unico que puede hacer, y
 * lo que conserva es lo que importa —el ORDEN RELATIVO de lo que se ve— que es
 * exactamente lo que la reconciliacion de la 9.2 tiene que corregir.
 *
 * DOS CONSECUENCIAS, las dos queridas y ninguna obvia:
 *
 *   - Una tarea que el cliente mostraba y que ya no esta en el orden del
 *     servidor DESAPARECE de esa columna. Es el caso de otro actor que la borro
 *     o que se la llevo a una columna que no entro en `affectedColumns`: la
 *     pantalla deja de afirmar algo que la base no dice.
 *   - Una tarea que el servidor trae y el cliente no conoce NO aparece: no hay
 *     con que dibujarla. La trae la revalidacion que corre a continuacion, que
 *     es la que si vuelve a leer el tablero entero.
 */
export function proyectarOrdenDelServidor(
  ordenDelServidor: readonly string[],
  visiblesAhora: readonly string[],
): string[] {
  const visibles = new Set(visiblesAhora);

  return ordenDelServidor.filter((id) => visibles.has(id));
}

/** Si dos ordenes son el mismo. Lo que decide si la reconciliacion CORRIGIO algo. */
export function mismoOrden(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, indice) => id === b[indice]);
}
