import type { Priority } from "@taskman/core";
import Link from "next/link";

import type { TareaEnTablero } from "../lib/tablero";

/**
 * TaskCard (9.3): "Titulo, indicador de prioridad, fecha limite y marca de
 * vencimiento".
 *
 * El titulo ocupa hasta DOS lineas y se corta ahi (queda entero en el `title` del
 * elemento); prioridad y fecha comparten la linea de abajo, y esa linea no se
 * renderiza si no hay ninguna de las dos.
 *
 * NO calcula si la tarea esta vencida: lo recibe ya resuelto. La regla mira la
 * key de la columna ademas de la fecha (6.3.2) y su unica definicion esta en el
 * nucleo, en `domain/vencimiento.ts`.
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

export function TaskCard({
  tarea,
  hoy,
  abierta,
}: {
  tarea: TareaEnTablero;
  hoy: Date;
  /** Si es la que el panel de detalle esta mostrando. */
  abierta: boolean;
}) {
  const prioridad = PRIORIDAD[tarea.priority];
  const clases = [
    "tarjeta",
    ...(prioridad === undefined ? [] : [prioridad.acento]),
    ...(abierta ? ["tarjeta--abierta"] : []),
  ].join(" ");

  return (
    <li>
      {/*
        LA TARJETA ENTERA ES UN ENLACE al panel de detalle, `/?tarea=<id>`. Un
        enlace y no un `onClick`, que es lo que la deja abrible con el teclado,
        con el boton del medio y con JavaScript apagado, y lo que permite que
        esta tarjeta siga siendo un componente de SERVIDOR: `next/link` se puede
        renderizar desde uno.

        Cuando entre dnd-kit va a haber que decidir aca que hace un arrastre que
        empieza sobre un enlace; hoy no hay arrastre y adelantarlo seria inventar
        el problema.
      */}
      <Link className="tarjeta-enlace" href={`/?tarea=${tarea.id}`} scroll={false}>
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
      </Link>
    </li>
  );
}
