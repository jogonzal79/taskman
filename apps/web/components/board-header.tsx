/**
 * BoardHeader (9.3): "Nombre del tablero, selector de tablero, filtros y accion
 * de nueva tarea".
 *
 * De los cuatro, hoy solo el NOMBRE. El selector, los filtros y la accion de
 * nueva tarea estan fuera del alcance de este paso —los tres son interactividad—
 * y ninguno se deja esbozado: un control que no hace nada es peor que no tenerlo.
 *
 * El recuento total del tablero va al lado del nombre y no es de la 9.3: es lo
 * unico que este paso agrega a la cabecera, y esta porque es el dato que dice de
 * un vistazo si la pagina trajo algo.
 */
export function BoardHeader({ nombre, taskCount }: { nombre: string; taskCount: number }) {
  return (
    <header className="cabecera">
      <h1 className="cabecera__nombre">{nombre}</h1>
      <span className="cabecera__recuento">
        {taskCount === 1 ? "1 tarea" : `${taskCount} tareas`}
      </span>
    </header>
  );
}
