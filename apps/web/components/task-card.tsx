"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Priority } from "@taskman/core";
import Link from "next/link";

import { enlaceTablero, type Filtros } from "../lib/filtros";
import type { TarjetaEnPantalla } from "../lib/tablero";

/**
 * TaskCard (9.3): "Titulo, indicador de prioridad, fecha limite y marca de
 * vencimiento", ahora ademas ARRASTRABLE (9.1).
 *
 * El titulo ocupa hasta DOS lineas y se corta ahi (queda entero en el `title` del
 * elemento); prioridad y fecha comparten la linea de abajo, y esa linea no se
 * renderiza si no hay ninguna de las dos.
 *
 * NO calcula si la tarea esta vencida: lo recibe ya resuelto. La regla mira la
 * key de la columna ademas de la fecha (6.3.2) y su unica definicion esta en el
 * nucleo, en `domain/vencimiento.ts`.
 *
 * PASO A SER DE CLIENTE en este paso, y no por gusto: `useSortable` es un hook y
 * el nodo que se arrastra tiene que llevar sus manejadores. Lo que cruza sigue
 * siendo poco —los cinco campos de `TarjetaEnPantalla`, sin `description`— y lo
 * que NO cambio es que el servidor la sigue renderizando: un componente de
 * cliente tambien se pinta en el HTML de la respuesta, asi que el tablero se ve
 * antes de que el navegador ejecute nada, igual que antes.
 *
 * LA TARJETA SIGUE SIENDO UN ENLACE al panel, y eso convive con el arrastre por
 * una razon concreta y no por suerte: el sensor de puntero se configura con una
 * restriccion de DISTANCIA (ver `ColumnList`), asi que un clic sin movimiento
 * nunca inicia un arrastre y navega; y en cuanto la restriccion se cumple,
 * dnd-kit cuelga un `stopPropagation` de `click` en captura sobre el documento
 * —comprobado en `core.cjs.development.js`, `AbstractPointerSensor.handleStart`—
 * que impide que el clic final del arrastre llegue a React y abra el panel.
 */

/**
 * SOLO URGENT Y HIGH llevan etiqueta. Las otras dos no aparecen, y la ausencia es
 * la decision: un chip gris que dice "Media" en la mayoria de las tarjetas de
 * cualquier tablero es texto identico en todas, o sea que no distingue ninguna, y
 * encima compite por la linea con la fecha, que si informa. Que una tarjeta no
 * diga nada ES que su prioridad es la corriente.
 *
 * El mapa es `Partial` a proposito: `PRIORIDAD[tarea.priority]` da `undefined`
 * para MEDIUM y LOW, que es exactamente lo que hay que pintar.
 */
const PRIORIDAD: Partial<Record<Priority, { texto: string; chip: string; acento: string }>> = {
  URGENT: { texto: "Urgente", chip: "prioridad--urgente", acento: "tarjeta--urgente" },
  HIGH: { texto: "Alta", chip: "prioridad--alta", acento: "tarjeta--alta" },
};

/**
 * La fecha, SIEMPRE leida en UTC.
 *
 * `due_date` es DATE y Prisma la entrega anclada a la medianoche UTC de ese dia
 * (ver `aFechaUtc` en lib/tareas.ts). Formatearla en la zona del proceso mostraria
 * el dia ANTERIOR en cualquier zona al oeste de Greenwich, que es el corrimiento
 * de un dia clasico de este campo. Es ademas la misma zona contra la que se
 * decide si esta vencida.
 *
 * El ano solo aparece cuando NO es el corriente: en un tablero todas las fechas
 * suelen ser de este ano, y repetirlo en cada tarjeta gasta la unica linea que
 * comparte con la prioridad.
 */
function formatearFecha(fecha: Date, hoy: Date): string {
  const mismoAno = fecha.getUTCFullYear() === hoy.getUTCFullYear();

  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(mismoAno ? {} : { year: "numeric" }),
  }).format(fecha);
}

/** `AAAA-MM-DD` para el atributo `datetime` de `<time>`. Misma lectura en UTC. */
function aIso(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/**
 * LO QUE SE VE de una tarjeta, sin nada de interactividad: ni enlace, ni asa, ni
 * hooks de arrastre.
 *
 * Esta separado porque lo dibujan DOS sitios y tienen que verse identicos: la
 * tarjeta en su columna y la copia que sigue al puntero durante el arrastre
 * (`DragOverlay`). Con dos marcados distintos, la copia se veria un pixel
 * corrida al empezar a arrastrar, que es el defecto clasico de un overlay hecho
 * a mano.
 */
export function TarjetaVisual({
  tarea,
  hoy,
  abierta = false,
  fantasma = false,
  ajena = false,
}: {
  tarea: TarjetaEnPantalla;
  hoy: Date;
  /** Si es la que el panel de detalle esta mostrando. */
  abierta?: boolean;
  /** El hueco que deja la tarjeta mientras su copia viaja con el puntero. */
  fantasma?: boolean;
  /**
   * La toco un agente o la API y el usuario todavia no la vio (9.1). Lleva la
   * animacion de entrada y el realce que se apaga.
   */
  ajena?: boolean;
}) {
  const prioridad = PRIORIDAD[tarea.priority];
  const clases = [
    "tarjeta",
    ...(prioridad === undefined ? [] : [prioridad.acento]),
    ...(abierta ? ["tarjeta--abierta"] : []),
    ...(fantasma ? ["tarjeta--fantasma"] : []),
    ...(ajena ? ["tarjeta--ajena"] : []),
  ].join(" ");

  return (
    <article className={clases}>
      {/* El `title` guarda el titulo completo, por si las dos lineas lo cortan. */}
      <h3 className="tarjeta__titulo" title={tarea.title}>
        {tarea.title}
      </h3>
      {(prioridad !== undefined || tarea.dueDate !== null) && (
        <p className="tarjeta__meta">
          {prioridad !== undefined && (
            <span className={`prioridad ${prioridad.chip}`}>{prioridad.texto}</span>
          )}
          {tarea.dueDate !== null && (
            <time
              className={tarea.vencida ? "fecha fecha--vencida" : "fecha"}
              dateTime={aIso(tarea.dueDate)}
            >
              {/* La marca de vencida es la PALABRA, no solo el rojo: asi sobrevive
                  a una captura en gris y a quien no distingue ese color. */}
              {tarea.vencida ? "Vencida · " : ""}
              {formatearFecha(tarea.dueDate, hoy)}
            </time>
          )}
        </p>
      )}
    </article>
  );
}

export function TaskCard({
  tarea,
  columnId,
  bloqueado,
  ajena,
  hoy,
  abierta,
  filtros,
}: {
  tarea: TarjetaEnPantalla;
  /** La columna donde se esta pintando AHORA, que durante un arrastre no es la suya. */
  columnId: string;
  /** Hay un movimiento en vuelo: no se puede empezar otro. Ver `ColumnList`. */
  bloqueado: boolean;
  /** La cambio otro actor y el usuario todavia no la vio (9.1). */
  ajena: boolean;
  hoy: Date;
  /** Si es la que el panel de detalle esta mostrando. */
  abierta: boolean;
  /**
   * Los filtros puestos. Van EN EL ENLACE: abrir una tarjeta con un filtro
   * puesto no puede perderlo, porque el destino es el mismo tablero con el panel
   * abierto y no un tablero distinto.
   */
  filtros: Filtros;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tarea.id,
    /*
      `disabled` y no el atributo `disabled` del `<button>`: el nativo saca el
      asa del orden de tabulacion y le quita el foco, asi que despues de mover
      una tarea con el teclado el foco se perderia justo cuando se quiere mover
      otra. Asi el asa se sigue pudiendo enfocar y dnd-kit le pone `aria-disabled`
      solo, que es lo que anuncia que ahora mismo no se puede.
    */
    disabled: bloqueado,
    // Lo lee `ColumnList` para saber en que columna estaba lo que se suelta
    // ENCIMA. Sin esto habria que buscar el id por las cuatro listas en cada
    // evento de `onDragOver`, que se dispara en cada pixel.
    data: { tipo: "tarea", columnId },
  });

  return (
    <li
      ref={setNodeRef}
      // `data-tarea` es el ancla del FLIP de la reconciliacion (ver
      // `useReordenAnimado`): hace falta un identificador ESTABLE en el DOM para
      // poder comparar donde estaba una tarjeta antes del cambio y donde quedo.
      data-tarea={tarea.id}
      className="tarjeta-caja"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Los manejadores de PUNTERO van en el `<li>` entero: se agarra la tarjeta
      // de cualquier parte, que es como se espera que funcione un tablero. El
      // `onKeyDown` que viene en el mismo paquete solo puede dispararse desde el
      // asa, porque es lo unico enfocable de aca dentro, y ademas el sensor de
      // teclado de dnd-kit compara `event.target` con el nodo activador y
      // descarta lo que venga de otro sitio.
      {...listeners}
    >
      <button
        type="button"
        className="tarjeta__asa"
        ref={setActivatorNodeRef}
        {...attributes}
        /*
          EL ASA EXISTE POR EL TECLADO, no por el raton. Con el raton sobra —se
          agarra la tarjeta entera— pero sin ella el arrastre seria una funcion
          que solo existe para quien puede apuntar y sostener: la 9.3 no lo pide
          y tampoco hace falta que lo pida.

          Y es ademas lo que hace que estas pruebas se puedan escribir. Un
          arrastre con el raton es una secuencia de coordenadas y depende de
          donde caiga cada tarjeta; con el asa, mover una tarea es Tab, Espacio,
          flechas y Espacio, que no depende de un solo pixel. Ver `arrastre.spec.ts`.

          `aria-roledescription` va DESPUES del spread para pisar el "sortable"
          en ingles que pone dnd-kit: lo que un lector de pantalla anuncia tiene
          que estar en el idioma de la pantalla.
        */
        aria-roledescription="control de movimiento"
        aria-label={`Mover ${tarea.title}`}
      >
        {/* Decorativo: el nombre accesible lo da el `aria-label`, asi que este
            glifo no debe anunciarse tambien. */}
        <span aria-hidden="true">⠿</span>
      </button>

      {/*
        LA TARJETA ENTERA ES UN ENLACE al panel de detalle, `/?tarea=<id>`. Un
        enlace y no un `onClick`, que es lo que la deja abrible con el teclado,
        con el boton del medio y con JavaScript apagado.

        `draggable={false}` apaga el arrastre NATIVO de los enlaces. Sin eso, al
        empezar a arrastrar el navegador tambien inicia su propio arrastre de
        enlace —con su imagen fantasma y su cursor de "copiar"— encima del de
        dnd-kit, y se ven los dos a la vez.
      */}
      <Link
        className="tarjeta-enlace"
        href={enlaceTablero(filtros, tarea.id)}
        scroll={false}
        draggable={false}
      >
        <TarjetaVisual
          tarea={tarea}
          hoy={hoy}
          abierta={abierta}
          fantasma={isDragging}
          ajena={ajena}
        />
      </Link>
    </li>
  );
}
