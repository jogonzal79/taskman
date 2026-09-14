"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { hayFiltros, type Filtros } from "../lib/filtros";
import type { ColumnaEnPantalla, TarjetaEnPantalla } from "../lib/tablero";
import { QuickAdd } from "./quick-add";
import { TaskCard } from "./task-card";

/**
 * ColumnCard (9.3): "Cabecera de columna con nombre y recuento; zona de destino
 * de arrastre".
 *
 * LA ZONA DE DESTINO ES EL `<ul>`, que es lo que ya estaba previsto cuando esto
 * se escribio en modo lectura. Es `useDroppable` ademas del `SortableContext`, y
 * las dos cosas hacen falta: el `SortableContext` resuelve soltar SOBRE otra
 * tarjeta —que es lo que pasa en una columna con contenido— y el droppable
 * resuelve soltar sobre la columna VACIA, donde no hay ninguna tarjeta que
 * pueda hacer de referencia. Sin el segundo, una columna sin tareas no se puede
 * usar como destino, que es justo el caso de un tablero recien creado.
 *
 * EL RECUENTO es el agregado de la base (`task_count` de la 6.2), no `tasks.length`:
 * si el listado se corto por el tope de pagina, el numero de la cabecera sigue
 * siendo el verdadero y el corte se dice aparte.
 *
 * EL RECUENTO NO ES OPTIMISTA. Durante un arrastre, las tarjetas ya se ven en la
 * columna destino y el numero de la cabecera todavia dice lo de antes, hasta que
 * la revalidacion lo trae. Es a proposito: ese numero SALE DE LA BASE —es el
 * unico dato de la pantalla que cuenta tambien lo que el filtro y el tope de
 * pagina esconden— asi que el cliente no lo puede recalcular sin inventarlo. Un
 * numero estimado que casi siempre acierta es peor que uno que va un instante
 * atrasado, porque el primero no se distingue del correcto.
 *
 * EL QUICKADD VA FUERA DEL `<ul>`, no como un `<li>` mas al final, y por dos
 * razones. La de marcado: un formulario no es un elemento de la lista de tareas,
 * y meterlo ahi dentro le diria a un lector de pantalla que la columna tiene una
 * tarea mas de las que tiene. La de comportamiento: el `<ul>` es el que desplaza
 * (`overflow-y: auto`), asi que un campo dentro de el se iria fuera de vista en
 * una columna llena, que es justo cuando mas se usa. Fuera, queda fijo al pie.
 * Con el arrastre hay una tercera: el `<ul>` es la zona de destino, y un
 * formulario dentro de ella seria superficie donde soltar.
 */
export function ColumnCard({
  boardId,
  columna,
  tareas,
  bloqueado,
  marcadas,
  hoy,
  tareaAbierta,
  filtros,
}: {
  /**
   * Baja desde la pagina y no se deduce de la columna: `CreateTaskInput` pide
   * `boardId` ademas de la referencia a la columna, y el nucleo comprueba que la
   * columna sea de ese tablero (`assertColumnaDelTablero`). Pasarlo explicito es
   * lo que le da a esa comprobacion algo que comparar.
   */
  boardId: string;
  columna: ColumnaEnPantalla;
  /**
   * LAS TARJETAS QUE VAN AHORA EN ESTA COLUMNA, en el orden en que se pintan.
   *
   * Llegan aparte de `columna` y no dentro, y es la diferencia entre antes y
   * ahora: `columna.tasks` es lo que dijo el SERVIDOR en el ultimo render, y
   * esto es el estado local de `ColumnList`, que durante un arrastre y hasta que
   * responde la accion dice otra cosa. Una tarjeta arrastrada a otra columna
   * aparece en el `tareas` de la columna destino sin estar en su `columna.tasks`.
   */
  tareas: readonly TarjetaEnPantalla[];
  /**
   * Hay un movimiento en vuelo: las tarjetas no se dejan agarrar. Baja entero
   * desde `ColumnList`, que es quien sabe si hay una accion sin responder; ver
   * ahi por que no alcanza con descartar el segundo arrastre al soltarlo.
   */
  bloqueado: boolean;
  /**
   * Las tareas que toco un agente o la API y el usuario todavia no vio (9.1).
   * Pasa de largo hasta la tarjeta; el conjunto es del TABLERO y no de esta
   * columna, porque una tarea marcada puede haber cambiado justamente de columna.
   */
  marcadas: ReadonlySet<string>;
  hoy: Date;
  /** La tarea abierta en el panel, si es alguna de esta columna. */
  tareaAbierta: string | undefined;
  filtros: Filtros;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: columna.id,
    // Lo que distingue soltar sobre UNA COLUMNA de soltar sobre una tarjeta.
    // Los dos ids son UUID, asi que por la forma no se pueden diferenciar.
    data: { tipo: "columna", columnId: columna.id },
  });

  const ids = tareas.map((tarea) => tarea.id);

  return (
    <section className="columna" aria-labelledby={`columna-${columna.id}`}>
      <header className="columna__cabecera">
        <h2 className="columna__nombre" id={`columna-${columna.id}`} title={columna.name}>
          {columna.name}
        </h2>
        {/*
          CON FILTRO, "1 de 4". Mismo criterio que el recuento del tablero: con
          solo el total el numero deja de describir lo que se ve, y con solo lo
          mostrado se pierde cuanto esconde el filtro, que es lo que uno quiere
          saber justo cuando filtra. El total sigue viniendo del agregado de la
          base y no de contar tarjetas, que es para lo que estaba desde el
          principio.
        */}
        <span className="columna__recuento">
          {hayFiltros(filtros)
            ? `${columna.tasks.length} de ${columna.taskCount}`
            : columna.taskCount}
        </span>
      </header>

      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={isOver ? "columna__tareas columna__tareas--destino" : "columna__tareas"}
        >
          {tareas.map((tarea) => (
            <TaskCard
              key={tarea.id}
              boardId={boardId}
              tarea={tarea}
              columnId={columna.id}
              bloqueado={bloqueado}
              ajena={marcadas.has(tarea.id)}
              hoy={hoy}
              abierta={tarea.id === tareaAbierta}
              filtros={filtros}
            />
          ))}

          {/*
            Una columna vacia es un estado normal de un tablero, no un error. Con
            filtro puesto, ademas, LA COLUMNA SIGUE ESTANDO: un tablero al que le
            desaparecen columnas segun el filtro desorienta —cambia la forma de lo
            que uno esta mirando— y esconde justamente el dato util, que es que ahi
            no hay nada que cumpla. Por eso el texto cambia y el hueco no.

            Y con el arrastre gana una segunda funcion: es la superficie sobre la
            que se suelta en una columna vacia, asi que su alto no es decorativo.
          */}
          {tareas.length === 0 && (
            <li className="columna__vacia">
              {hayFiltros(filtros) ? "Ninguna con este filtro" : "Sin tareas"}
            </li>
          )}

          {/*
            El aviso de corte de pagina. Sin filtro se sabe cuantas faltan; con
            filtro solo se sabe QUE faltan (ver `omitidas` en lib/tablero.ts), asi
            que el texto no inventa un numero.
          */}
          {columna.recorte && (
            <li className="columna__resto">
              {columna.omitidas === 0
                ? "hay mas que no entraron en la pagina"
                : columna.omitidas === 1
                  ? "1 tarea mas sin mostrar"
                  : `${columna.omitidas} tareas mas sin mostrar`}
            </li>
          )}
        </ul>
      </SortableContext>

      <QuickAdd boardId={boardId} columnId={columna.id} columnName={columna.name} />
    </section>
  );
}
