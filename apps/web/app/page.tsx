import { BoardHeader } from "../components/board-header";
import { BoardSidebar } from "../components/board-sidebar";
import { ColumnList } from "../components/column-list";
import { cargarVista } from "../lib/tablero";

/**
 * El tablero en modo LECTURA (9.1, 9.3).
 *
 * ES UN SERVER COMPONENT, y se puede comprobar sin creerlo: la funcion es `async`
 * y espera al nucleo, cosa que un Componente de Cliente no puede ser; el modulo
 * llega por `lib/tablero.ts` hasta `@taskman/core` y de ahi a `pg`, que en el
 * bundle del navegador no compila; y no hay un "use client" en todo `apps/web`.
 * Del lado empirico: el HTML que devuelve el servidor ya trae las columnas y las
 * tarjetas, sin que el navegador ejecute nada.
 *
 * NO HAY "use client" EN NINGUN ARCHIVO DE ESTE PASO. La unica cosa que en la 9.3
 * lo habria exigido —medir el ancho para el aviso de pantalla angosta— se resolvio
 * con una media query. Lo exigiran dnd-kit y TanStack Query cuando entre la
 * interactividad, y por eso `ColumnList` ya es una pieza aparte: ese limite va a
 * caer ahi.
 *
 * UN SOLO INSTANTE PARA TODA LA PAGINA: `hoy` se calcula una vez y baja como
 * propiedad. Si cada tarjeta leyera su propio `new Date()`, una carga que cruzara
 * la medianoche pintaria unas tarjetas vencidas y otras no.
 */

// Un tablero cacheado responde por el estado de otro momento; ademas los agentes
// escriben por MCP y por la API sin pasar por aca. Mismo criterio que los Route
// Handlers de /api/boards/{id}.
export const dynamic = "force-dynamic";

export default async function PaginaTablero() {
  const hoy = new Date();
  const { tableros, tablerosOmitidos, actual } = await cargarVista(hoy);

  // Sin tableros no hay barra que dibujar: estaria vacia al lado de un hueco.
  if (actual === undefined) {
    return (
      <p className="sin-tablero">
        No hay ningun tablero todavia. Crea uno con POST /api/boards o con la
        herramienta create_board del servidor MCP.
      </p>
    );
  }

  return (
    <div className="marco">
      <BoardSidebar tableros={tableros} omitidos={tablerosOmitidos} />
      <main className="pagina">
        <BoardHeader nombre={actual.name} taskCount={actual.taskCount} />
        <ColumnList columnas={actual.columns} hoy={hoy} />
      </main>
    </div>
  );
}
