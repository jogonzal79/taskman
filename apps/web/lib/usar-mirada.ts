"use client";

import { useEffect } from "react";

/**
 * "HASTA QUE EL USUARIO LA MIRE": que significa, y por que se decidio asi.
 *
 * La marca de un cambio ajeno tiene que sobrevivir a lo que la hizo aparecer
 * —normalmente la pestaña estaba de fondo mientras el agente trabajaba— y
 * apagarse cuando la persona ya la vio. El problema es que "mirar" no es un
 * evento del navegador, asi que hay que elegir el sustituto menos mentiroso.
 *
 * LO QUE SE DESCARTO, y por que cada uno miente:
 *
 *   - `visibilitychange` a visible. Una pestaña visible en el segundo monitor,
 *     con la persona escribiendo en otra ventana, esta "visible" y nadie la
 *     mira. Con esto, los cambios que llegan mientras el tablero esta abierto al
 *     lado se apagarian sin que nadie los viera nunca, que es justo el caso que
 *     el realce existe para cubrir.
 *   - El foco de la ventana. Mismo problema, un poco mas debil: una ventana
 *     enfocada puede estar tapada, y ademas el foco vuelve solo al alternar
 *     aplicaciones con el teclado.
 *   - Un temporizador. "A los N segundos se apaga" no describe a la persona: si
 *     esta, sobra el temporizador; si no esta, el realce se apago solo y el
 *     cambio quedo invisible.
 *   - Que la tarjeta entre en el viewport (`IntersectionObserver`). Suena mas
 *     preciso y no lo es: en un tablero Kanban todas las tarjetas ya estan a la
 *     vista, asi que se apagaria en el mismo instante en que aparece.
 *
 * LO QUE SE ELIGIO: la pestaña VISIBLE mas una señal de entrada real —mover el
 * puntero, pulsar una tecla, hacer clic o desplazar—. Es la prueba mas barata de
 * que hay una persona delante de ESTA pagina, y ademas es el mismo gesto con el
 * que iria a hacer algo con lo que acaba de ver. Se apaga con la PRIMERA señal,
 * no con la que toque la tarjeta: "mirar" es mirar la pantalla, y una marca que
 * exigiera pasar por encima de cada tarjeta se volveria una tarea.
 *
 * CONSECUENCIA ACEPTADA: si la persona ya estaba con la mano en el raton cuando
 * el agente escribio, la marca dura lo que tarde en moverlo. Es correcto por
 * definicion —estaba mirando— y la entrada de la tarjeta se ve igual, porque la
 * animacion la dispara el propio montaje de la clase.
 */

/**
 * Las cuatro señales. `pointermove` es la que se dispara casi siempre; las otras
 * tres cubren a quien navega con teclado, a quien usa una pantalla tactil y a
 * quien desplaza sin mover el puntero.
 */
const SEÑALES = ["pointermove", "pointerdown", "keydown", "wheel"] as const;

/**
 * Llama a `alMirar` la primera vez que el usuario da señales de estar delante,
 * mientras `esperando` sea cierto.
 *
 * Los oyentes se cuelgan SOLO cuando hay algo que mirar y se quitan al apagarse:
 * sin marcas pendientes no hay ningun motivo para escuchar cada movimiento del
 * puntero de la pagina.
 */
export function useMirada(esperando: boolean, alMirar: () => void): void {
  useEffect(() => {
    if (!esperando) {
      return;
    }

    function mirar(): void {
      // Una señal en una pestaña oculta no es una mirada. Un `keydown`
      // despachado por script, o el `pointermove` que algunos navegadores
      // entregan al restaurar, entrarian por aca.
      if (document.visibilityState !== "visible") {
        return;
      }

      alMirar();
    }

    for (const señal of SEÑALES) {
      // `passive` porque ninguno de los cuatro se cancela, y `wheel` sin esto
      // bloquea el desplazamiento mientras se resuelve el manejador.
      document.addEventListener(señal, mirar, { passive: true });
    }

    return () => {
      for (const señal of SEÑALES) {
        document.removeEventListener(señal, mirar);
      }
    };
  }, [esperando, alMirar]);
}
