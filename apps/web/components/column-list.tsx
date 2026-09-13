import type { Filtros } from "../lib/filtros";
import type { ColumnaEnTablero } from "../lib/tablero";
import { ColumnCard } from "./column-card";

/**
 * ColumnList (9.3): "Contenedor con scroll horizontal; gestiona el contexto de
 * dnd-kit".
 *
 * El contexto de dnd-kit no existe todavia —F3 en lectura no tiene
 * interactividad— y por eso este componente es hoy poco mas que el contenedor con
 * scroll. Se escribe igual como pieza propia porque es el sitio donde ese
 * contexto va a entrar, y ese contexto SI va a exigir "use client": tenerlo ya
 * separado de la pagina hace que ese dia el limite cliente/servidor caiga aca y
 * no se lleve por delante al Server Component que carga los datos.
 *
 * Las columnas llegan EN ORDEN: es el orden que devuelve el nucleo
 * (`readBoardColumns`, por `position`), no uno que este componente reordene.
 *
 * `boardId` solo pasa de largo: lo necesita el QuickAdd de cada columna, que es
 * el unico que escribe. Va por aca y no leido de nuevo mas abajo porque el dato
 * ya lo tiene la pagina (`cargarVista`), y volver a consultarlo en un componente
 * abriria un segundo camino a la base desde el arbol de render.
 */
export function ColumnList({
  boardId,
  columnas,
  hoy,
  tareaAbierta,
  filtros,
}: {
  boardId: string;
  columnas: ColumnaEnTablero[];
  hoy: Date;
  /**
   * La tarea que el panel esta mostrando, para que su tarjeta se distinga. Pasa
   * de largo como `boardId`: sale del parametro de consulta que ya leyo la
   * pagina, no de un estado de cliente que habria que sincronizar.
   */
  tareaAbierta: string | undefined;
  /** Pasan de largo hasta el enlace de cada tarjeta: abrir el panel no los pierde. */
  filtros: Filtros;
}) {
  return (
    <div className="columnas">
      {columnas.map((columna) => (
        <ColumnCard
          key={columna.id}
          boardId={boardId}
          columna={columna}
          hoy={hoy}
          tareaAbierta={tareaAbierta}
          filtros={filtros}
        />
      ))}
    </div>
  );
}
