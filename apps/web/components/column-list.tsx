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
 */
export function ColumnList({ columnas, hoy }: { columnas: ColumnaEnTablero[]; hoy: Date }) {
  return (
    <div className="columnas">
      {columnas.map((columna) => (
        <ColumnCard key={columna.id} columna={columna} hoy={hoy} />
      ))}
    </div>
  );
}
