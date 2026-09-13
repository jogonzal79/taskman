import { hayFiltros, type Filtros } from "../lib/filtros";
import type { ColumnaEnTablero } from "../lib/tablero";
import { QuickAdd } from "./quick-add";
import { TaskCard } from "./task-card";

/**
 * ColumnCard (9.3): "Cabecera de columna con nombre y recuento; zona de destino
 * de arrastre".
 *
 * La zona de destino no existe todavia: F3 en lectura no monta dnd-kit. Lo que si
 * queda definido es el contenedor que la va a recibir, que es el `<ul>`.
 *
 * El RECUENTO es el agregado de la base (`task_count` de la 6.2), no `tasks.length`:
 * si el listado se corto por el tope de pagina, el numero de la cabecera sigue
 * siendo el verdadero y el corte se dice aparte.
 *
 * EL QUICKADD VA FUERA DEL `<ul>`, no como un `<li>` mas al final, y por dos
 * razones. La de marcado: un formulario no es un elemento de la lista de tareas,
 * y meterlo ahi dentro le diria a un lector de pantalla que la columna tiene una
 * tarea mas de las que tiene. La de comportamiento: el `<ul>` es el que desplaza
 * (`overflow-y: auto`), asi que un campo dentro de el se iria fuera de vista en
 * una columna llena, que es justo cuando mas se usa. Fuera, queda fijo al pie.
 *
 * ESTE COMPONENTE SIGUE SIENDO DE SERVIDOR: renderiza uno de cliente y le pasa
 * dos ids y un nombre, que son datos serializables. El limite cliente/servidor
 * cae dentro de `QuickAdd`, no aca.
 */
export function ColumnCard({
  boardId,
  columna,
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
  columna: ColumnaEnTablero;
  hoy: Date;
  /** La tarea abierta en el panel, si es alguna de esta columna. */
  tareaAbierta: string | undefined;
  filtros: Filtros;
}) {
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

      <ul className="columna__tareas">
        {columna.tasks.map((tarea) => (
          <TaskCard
            key={tarea.id}
            tarea={tarea}
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
        */}
        {columna.tasks.length === 0 && (
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

      <QuickAdd boardId={boardId} columnId={columna.id} columnName={columna.name} />
    </section>
  );
}
