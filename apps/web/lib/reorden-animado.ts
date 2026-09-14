"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Hace VISIBLE la correccion del punto 3 de la 9.2.
 *
 * El problema que resuelve no es estetico. Cuando el orden que devuelve el
 * servidor no coincide con el que calculo el navegador —porque un agente movio
 * algo por MCP entre medio— el estado local se SUSTITUYE por el del servidor, y
 * si eso se aplica sin mas, la persona ve saltar una tarjeta a otro sitio sin
 * ninguna explicacion, justo despues de haber soltado otra. Un salto asi se lee
 * como "el arrastre no funciono", y a partir de ahi nadie vuelve a confiar en
 * que la tarjeta se quedo donde la puso. Un MOVIMIENTO, en cambio, se lee como
 * lo que es: algo cambio y se esta acomodando.
 *
 * ES LA TECNICA "FLIP", y no hay libreria: se mide donde estaba cada tarjeta
 * ANTES del cambio (el ultimo commit), se deja que React reordene el DOM, se
 * mide donde quedo, y se la anima DESDE la diferencia HASTA cero. El navegador
 * ya pinto el estado final; lo que se anima es una transformacion encima, asi
 * que no hay ningun momento en el que el DOM mienta sobre el orden. Eso importa
 * mas de lo que parece: una prueba que lea el orden del DOM mientras la
 * animacion corre lee el orden CORRECTO, el final.
 *
 * POR QUE NO LO HACE dnd-kit. Su animacion de reordenamiento es la del ARRASTRE:
 * anima lo que se mueve mientras se arrastra y al soltar. La correccion llega
 * despues, cuando responde la Server Action, cuando ya no hay ningun arrastre en
 * curso y ninguna de sus animaciones esta escuchando.
 *
 * SE ANIMA SOLO CUANDO SE PIDE, con `marcar()`. Medir en cada commit es barato y
 * hace falta —sin la medida anterior no hay "antes"— pero animar en cada commit
 * convertiria cada revalidacion y cada cambio de filtro en un baile de tarjetas.
 * La que decide es `ColumnList`, que es la unica que sabe cuando esta corrigiendo.
 */

/** Lo que dura la correccion. Suficiente para seguirla con la vista, y no mas. */
const DURACION_MS = 220;

interface Medida {
  readonly nodo: HTMLElement;
  readonly left: number;
  readonly top: number;
}

/**
 * Devuelve `marcar`: llamalo JUSTO ANTES del `setState` cuyo reordenamiento
 * quieras ver animado.
 *
 * `contenedor` es el elemento que envuelve las columnas; las tarjetas se buscan
 * por `[data-tarea]`, que es el identificador estable que pone `TaskCard`. Se
 * buscan en el CONTENEDOR ENTERO y no por columna a proposito: una correccion
 * puede mover una tarjeta de una columna a otra, y ahi el desplazamiento es
 * horizontal ademas de vertical.
 */
export function useReordenAnimado(contenedor: RefObject<HTMLElement | null>): () => void {
  const anteriores = useRef(new Map<string, Medida>());
  const pendiente = useRef(false);

  /**
   * SIN ARRAY DE DEPENDENCIAS: tiene que correr despues de CADA commit, porque
   * cualquiera de ellos puede ser el "antes" del siguiente. Y `useLayoutEffect`
   * y no `useEffect`, porque mide y escribe estilos: con el segundo, el
   * navegador pintaria el estado final antes de la animacion y se veria el salto
   * que esto existe para evitar.
   */
  useLayoutEffect(() => {
    const raiz = contenedor.current;

    if (raiz === null) {
      return;
    }

    const ahora = new Map<string, Medida>();

    for (const nodo of raiz.querySelectorAll<HTMLElement>("[data-tarea]")) {
      const id = nodo.dataset["tarea"];

      if (id === undefined) {
        continue;
      }

      const caja = nodo.getBoundingClientRect();
      ahora.set(id, { nodo, left: caja.left, top: caja.top });
    }

    if (pendiente.current) {
      pendiente.current = false;
      animar(anteriores.current, ahora);
    }

    anteriores.current = ahora;
  });

  return () => {
    pendiente.current = true;
  };
}

function animar(antes: ReadonlyMap<string, Medida>, ahora: ReadonlyMap<string, Medida>): void {
  /**
   * "Reducir el movimiento" es una preferencia del sistema y se respeta: para
   * quien la tiene puesta, una tarjeta deslizandose no es informacion sino
   * mareo. El orden final es el mismo en los dos casos, asi que lo unico que se
   * pierde es la explicacion visual.
   */
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  for (const [id, destino] of ahora) {
    const origen = antes.get(id);

    // Una tarjeta que no estaba en el commit anterior no tiene de donde venir:
    // aparece, y aparecer no es moverse.
    if (origen === undefined) {
      continue;
    }

    const dx = origen.left - destino.left;
    const dy = origen.top - destino.top;

    // Medio pixel de diferencia es ruido de maquetado, no un movimiento.
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      continue;
    }

    // `animate` no existe en navegadores viejos y no vale romper la pagina por
    // una animacion: sin ella la correccion se aplica igual, solo que de golpe.
    if (typeof destino.nodo.animate !== "function") {
      continue;
    }

    destino.nodo.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
      { duration: DURACION_MS, easing: "ease-out" },
    );
  }
}
