import type { ColumnaEnTablero } from "../lib/tablero";
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
 */
export function ColumnCard({ columna, hoy }: { columna: ColumnaEnTablero; hoy: Date }) {
  return (
    <section className="columna" aria-labelledby={`columna-${columna.id}`}>
      <header className="columna__cabecera">
        <h2 className="columna__nombre" id={`columna-${columna.id}`} title={columna.name}>
          {columna.name}
        </h2>
        <span className="columna__recuento">{columna.taskCount}</span>
      </header>

      <ul className="columna__tareas">
        {columna.tasks.map((tarea) => (
          <TaskCard key={tarea.id} tarea={tarea} hoy={hoy} />
        ))}

        {/* Una columna vacia es un estado normal de un tablero, no un error. */}
        {columna.tasks.length === 0 && <li className="columna__vacia">Sin tareas</li>}

        {columna.omitidas > 0 && (
          <li className="columna__resto">
            {columna.omitidas === 1 ? "1 tarea mas sin mostrar" : `${columna.omitidas} tareas mas sin mostrar`}
          </li>
        )}
      </ul>
    </section>
  );
}
