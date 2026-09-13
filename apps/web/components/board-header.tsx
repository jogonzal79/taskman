import Link from "next/link";

import {
  alternarPrioridad,
  alternarVencidas,
  enlaceTablero,
  hayFiltros,
  type Filtros,
} from "../lib/filtros";
import { PRIORIDADES } from "../lib/prioridad";

/**
 * BoardHeader (9.3): "Nombre del tablero, selector de tablero, filtros y accion
 * de nueva tarea".
 *
 * De los cuatro ya son dos: el NOMBRE y los FILTROS. El selector de tablero y la
 * accion de nueva tarea siguen fuera —la creacion se hace desde el QuickAdd al
 * pie de cada columna, que es donde se elige la columna sin un formulario— y
 * ninguno se deja esbozado.
 *
 * LOS FILTROS SON ENLACES, no botones, y no hay un solo "use client" en esta
 * pieza. Cada chip apunta a la URL que resultaria de alternarlo, asi que:
 *
 *   - lo que se ve encendido y lo que se aplica son el mismo dato, por
 *     construccion y no por sincronizacion;
 *   - el filtrado ocurre en el SERVIDOR, con la consulta ya filtrada, y no
 *     escondiendo tarjetas que igual se trajeron;
 *   - funciona con el teclado, con el boton del medio y sin JavaScript, y el
 *     boton de atras deshace el ultimo filtro.
 *
 * EL NOMBRE ACCESIBLE DICE LA ACCION —"Filtrar por Alta" o "Quitar el filtro
 * Alta"— y no solo la etiqueta. Un enlace se anuncia por su nombre, asi que
 * decir "Alta" a secas dejaria a quien no ve el chip sin saber si esta puesto.
 * Por eso tampoco lleva `aria-pressed`, que es de botones, ni `aria-current`, que
 * significa "el item actual de un conjunto" y un filtro no es eso.
 */
export function BoardHeader({
  nombre,
  taskCount,
  mostradas,
  filtros,
  tareaAbierta,
}: {
  nombre: string;
  /** Total del tablero, agregado en la base y sin filtrar. */
  taskCount: number;
  /** Cuantas se estan mostrando. Igual al total cuando no hay filtro. */
  mostradas: number;
  filtros: Filtros;
  /** Se conserva en cada enlace: filtrar no cierra el panel abierto. */
  tareaAbierta: string | undefined;
}) {
  const filtrando = hayFiltros(filtros);

  return (
    <header className="cabecera">
      <h1 className="cabecera__nombre">{nombre}</h1>

      {/*
        EL RECUENTO DICE LAS DOS COSAS cuando hay filtro: "3 de 11 tareas". Con
        solo el total, el numero dejaria de describir la pantalla en cuanto se
        filtra; con solo lo mostrado, se perderia justamente el dato que uno
        quiere al filtrar, que es cuanto esta escondiendo el filtro. El total
        sigue saliendo del agregado de la base y no de contar tarjetas.
      */}
      <span className="cabecera__recuento">
        {filtrando ? `${mostradas} de ${taskCount} tareas` : taskCount === 1 ? "1 tarea" : `${taskCount} tareas`}
      </span>

      <div className="filtros" role="group" aria-label="Filtros del tablero">
        {PRIORIDADES.map((opcion) => {
          const puesta = filtros.prioridades.includes(opcion.valor);

          return (
            <Link
              key={opcion.valor}
              className={puesta ? "filtro filtro--puesto" : "filtro"}
              href={enlaceTablero(alternarPrioridad(filtros, opcion.valor), tareaAbierta)}
              scroll={false}
              aria-label={puesta ? `Quitar el filtro ${opcion.texto}` : `Filtrar por ${opcion.texto}`}
            >
              {opcion.texto}
            </Link>
          );
        })}

        <Link
          className={filtros.vencidas ? "filtro filtro--puesto" : "filtro"}
          href={enlaceTablero(alternarVencidas(filtros), tareaAbierta)}
          scroll={false}
          aria-label={filtros.vencidas ? "Quitar el filtro Vencidas" : "Filtrar por Vencidas"}
        >
          Vencidas
        </Link>

        {/*
          QUITAR TODO EN UN PASO. Solo aparece cuando hay algo que quitar: un
          enlace permanente que la mitad del tiempo no hace nada es ruido, y su
          ausencia es ademas la senal mas barata de que no hay filtro puesto.
          Conserva `tarea`, asi que quitar los filtros no cierra el panel.
        */}
        {filtrando && (
          <Link className="filtro filtro--limpiar" href={enlaceTablero({ prioridades: [], vencidas: false }, tareaAbierta)} scroll={false}>
            Quitar filtros
          </Link>
        )}
      </div>
    </header>
  );
}
