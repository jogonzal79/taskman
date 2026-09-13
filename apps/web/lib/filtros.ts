import type { Priority } from "@taskman/core";

import { PRIORIDADES } from "./prioridad";

/**
 * Los filtros del tablero (9.3: "BoardHeader ... filtros"), leidos y escritos en
 * la URL.
 *
 * EN LA URL Y NO EN ESTADO DE CLIENTE, por lo mismo que el panel de detalle: el
 * estado de la pantalla entero vive en un solo lugar. Un tablero filtrado se
 * comparte pegando el enlace, sobrevive al recargado, y el boton de atras deshace
 * el ultimo filtro. Ademas —y esto es lo que decide— el filtrado lo hace el
 * NUCLEO: la pagina se vuelve a renderizar en el servidor con la consulta ya
 * filtrada, en vez de traer el tablero entero y esconder tarjetas en el navegador.
 *
 * CONSECUENCIA QUERIDA: los controles de filtro son ENLACES, no botones. No hay
 * un solo "use client" en esta funcionalidad. Cada chip apunta a la URL que
 * resultaria de alternarlo, asi que el estado que se ve y el que se aplica son el
 * mismo por construccion, y todo funciona con el teclado y sin JavaScript.
 *
 * LOS NOMBRES DE LOS PARAMETROS SON LOS DE LA UI, no los de la 6.3.2. `prioridad`
 * y `vencidas` en vez de `priority` y `overdue`, igual que `tarea` en vez de
 * `task_id`. Es a proposito: la UI no consume su propia API publica (9.1), asi
 * que estos parametros no son ese contrato y parecerse a el sugeriria que si lo
 * son. Lo que SI se comparte es la semantica, que vive en el nucleo.
 */

export interface Filtros {
  /**
   * Prioridades seleccionadas. Varias actuan como OR, que es lo que hace el
   * `priority IN (...)` del nucleo y lo que la 6.3.2 declara.
   */
  readonly prioridades: readonly Priority[];
  /**
   * Solo las vencidas. Es el `overdue` de la 6.3.2, o sea con fecha pasada Y
   * FUERA de la columna terminal. La definicion no se repite aca: se pasa al
   * nucleo, que la aplica con la misma `COLUMNA_TERMINAL` de
   * `domain/vencimiento.ts` con la que la UI decide si pinta la marca. Si esto
   * tuviera su propia version, una tarea podria salir marcada como vencida y
   * escondida por el filtro de vencidas a la vez.
   */
  readonly vencidas: boolean;
}

export const SIN_FILTROS: Filtros = { prioridades: [], vencidas: false };

export function hayFiltros(filtros: Filtros): boolean {
  return filtros.prioridades.length > 0 || filtros.vencidas;
}

/** El orden canonico de las prioridades, el mismo del selector del panel. */
const ORDEN_PRIORIDAD: readonly Priority[] = PRIORIDADES.map((opcion) => opcion.valor);

const ES_PRIORIDAD = new Set<string>(ORDEN_PRIORIDAD);

type Parametros = Record<string, string | string[] | undefined>;

function comoLista(valor: string | string[] | undefined): string[] {
  if (valor === undefined) {
    return [];
  }

  return typeof valor === "string" ? [valor] : valor;
}

/**
 * Lee los filtros de los parametros de consulta.
 *
 * UN VALOR QUE NO ES UNA PRIORIDAD SE DESCARTA, y hay que ser consciente de lo
 * que eso significa: `?prioridad=ALTISIMA` no filtra por nada y muestra el
 * tablero entero, que es lo mismo que no haber pedido nada. En un endpoint REST
 * eso seria la deuda que CLAUDE.md anota —un parametro que quedo INERTE sin que
 * el llamador se entere— pero aca no lo es, y la diferencia es concreta: la
 * pantalla DIBUJA los filtros que aplico. Los chips que se ven encendidos son
 * exactamente `filtros.prioridades`, asi que la UI nunca puede afirmar un filtro
 * que no esta aplicando. Un JSON no tiene como decir eso.
 *
 * Los repetidos se colapsan y el orden se normaliza al canonico, asi que
 * `?prioridad=HIGH&prioridad=URGENT` y `?prioridad=URGENT&prioridad=HIGH&prioridad=HIGH`
 * producen la MISMA consulta y el MISMO enlace. Sin eso, dos URL distintas
 * darian la misma pantalla y compartir una seria una loteria.
 */
export function leerFiltros(parametros: Parametros): Filtros {
  const pedidas = new Set(comoLista(parametros["prioridad"]).filter((valor) => ES_PRIORIDAD.has(valor)));

  return {
    prioridades: ORDEN_PRIORIDAD.filter((prioridad) => pedidas.has(prioridad)),
    // Solo el "1" enciende. Cualquier otra cosa —"true", "0", vacio— es no, y no
    // por descuido: el enlace que escribe esta misma pagina siempre pone "1", asi
    // que lo demas viene de alguien tecleando la URL a mano y lo unico razonable
    // es no adivinar.
    vencidas: parametros["vencidas"] === "1",
  };
}

/** El id del panel abierto, si el parametro apunta a algo. */
export function leerTareaAbierta(parametros: Parametros): string | undefined {
  const valor = parametros["tarea"];

  return typeof valor === "string" && valor !== "" ? valor : undefined;
}

/**
 * La URL del tablero con estos filtros y este panel. Es la UNICA forma en que se
 * arma un enlace de esta pagina: los chips, las tarjetas y el cierre del panel
 * pasan todos por aca, que es lo que hace que ninguno pierda el estado del otro.
 *
 * El orden de los parametros es fijo —prioridades en el orden canonico, despues
 * vencidas, despues la tarea— para que la misma pantalla sea siempre la misma
 * cadena. Dos URL distintas para el mismo estado harian que el enlace que uno
 * comparte dependa de en que orden pulso los chips.
 */
export function enlaceTablero(filtros: Filtros, tarea?: string | undefined): string {
  const parametros = new URLSearchParams();

  for (const prioridad of filtros.prioridades) {
    parametros.append("prioridad", prioridad);
  }

  if (filtros.vencidas) {
    parametros.set("vencidas", "1");
  }

  if (tarea !== undefined) {
    parametros.set("tarea", tarea);
  }

  const cadena = parametros.toString();

  return cadena === "" ? "/" : `/?${cadena}`;
}

/** Los filtros que resultarian de encender o apagar una prioridad. */
export function alternarPrioridad(filtros: Filtros, prioridad: Priority): Filtros {
  const puestas = new Set(filtros.prioridades);

  if (puestas.has(prioridad)) {
    puestas.delete(prioridad);
  } else {
    puestas.add(prioridad);
  }

  return {
    ...filtros,
    prioridades: ORDEN_PRIORIDAD.filter((candidata) => puestas.has(candidata)),
  };
}

/** Los filtros que resultarian de encender o apagar "vencidas". */
export function alternarVencidas(filtros: Filtros): Filtros {
  return { ...filtros, vencidas: !filtros.vencidas };
}
