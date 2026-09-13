import { BoardHeader } from "../components/board-header";
import { BoardSidebar } from "../components/board-sidebar";
import { ColumnList } from "../components/column-list";
import { TaskDetailPanel } from "../components/task-detail-panel";
import { cargarVista, ubicarEnVista } from "../lib/tablero";

/**
 * El tablero (9.1, 9.3). Lectura, mas la unica escritura que ya existe: el
 * QuickAdd al pie de cada columna.
 *
 * ES UN SERVER COMPONENT, y se puede comprobar sin creerlo: la funcion es `async`
 * y espera al nucleo, cosa que un Componente de Cliente no puede ser; el modulo
 * llega por `lib/tablero.ts` hasta `@taskman/core` y de ahi a `pg`, que en el
 * bundle del navegador no compila; y no hay un "use client" en todo `apps/web`.
 * Del lado empirico: el HTML que devuelve el servidor ya trae las columnas y las
 * tarjetas, sin que el navegador ejecute nada.
 *
 * EL UNICO "use client" DEL PROYECTO es `QuickAdd`, y el limite cae ahi abajo y
 * no aca: esta pagina, `ColumnList` y `ColumnCard` siguen siendo de servidor, y
 * lo que cruza son dos ids y un nombre. El aviso de pantalla angosta, que en la
 * 9.3 habria sido el otro candidato a cliente, se resolvio con una media query y
 * sigue sin necesitar JavaScript. Lo que va a mover el limite hacia arriba son
 * dnd-kit y TanStack Query: el contexto de arrastre vive en `ColumnList`, y por
 * eso `ColumnList` ya es una pieza aparte.
 *
 * UN SOLO INSTANTE PARA TODA LA PAGINA: `hoy` se calcula una vez y baja como
 * propiedad. Si cada tarjeta leyera su propio `new Date()`, una carga que cruzara
 * la medianoche pintaria unas tarjetas vencidas y otras no.
 */

// Un tablero cacheado responde por el estado de otro momento; ademas los agentes
// escriben por MCP y por la API sin pasar por aca. Mismo criterio que los Route
// Handlers de /api/boards/{id}.
export const dynamic = "force-dynamic";

/**
 * QUE TAREA ESTA ABIERTA VIVE EN LA URL, no en estado de cliente: `/?tarea=<id>`.
 * Ver el comentario de `TaskDetailPanel` para las tres cosas que eso resuelve; la
 * que importa aca es que el panel se resuelve y se renderiza en el SERVIDOR, asi
 * que abrirlo no manda el tablero al navegador.
 *
 * Un valor repetido (`?tarea=a&tarea=b`) llega como array y se descarta: pedir
 * dos tareas a la vez no significa nada y elegir una seria inventar una regla.
 */
function leerTareaAbierta(parametros: Record<string, string | string[] | undefined>): string | undefined {
  const valor = parametros["tarea"];

  return typeof valor === "string" && valor !== "" ? valor : undefined;
}

export default async function PaginaTablero({
  searchParams,
}: {
  // En Next 16 los parametros de consulta llegan como Promise, igual que los de
  // ruta en un Route Handler.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hoy = new Date();
  const [{ tableros, tablerosOmitidos, actual }, parametros] = await Promise.all([
    cargarVista(hoy),
    searchParams,
  ]);
  const tareaAbierta = leerTareaAbierta(parametros);

  // Sin tableros no hay barra que dibujar: estaria vacia al lado de un hueco.
  if (actual === undefined) {
    return (
      <p className="sin-tablero">
        No hay ningun tablero todavia. Crea uno con POST /api/boards o con la
        herramienta create_board del servidor MCP.
      </p>
    );
  }

  /**
   * La tarea del panel se busca DENTRO del tablero ya cargado, sin consultar. Un
   * id inexistente, uno de otro tablero o el de una tarea que se acaba de borrar
   * dan `undefined` y la pagina dibuja el tablero sin panel: un enlace viejo en
   * la barra de direcciones no es un error del sistema. Ver `ubicarEnVista`.
   */
  const ubicada = ubicarEnVista(actual, tareaAbierta);

  return (
    <div className="marco">
      <BoardSidebar tableros={tableros} omitidos={tablerosOmitidos} />
      <main className="pagina">
        <BoardHeader nombre={actual.name} taskCount={actual.taskCount} />
        <ColumnList
          boardId={actual.id}
          columnas={actual.columns}
          hoy={hoy}
          // El id del parametro y no el de `ubicada`: si apunta a nada, no hay
          // tarjeta que marcar y las dos formas coinciden. Con `ubicada` habria
          // que desenvolverlo para lo mismo.
          tareaAbierta={tareaAbierta}
        />
      </main>
      {/*
        HERMANO del `<main>`, no encima: el panel se abre al costado y el
        tablero se estrecha. Es la diferencia entre un panel y un modal, y es
        por eso que no hay capa, ni superposicion, ni foco atrapado.
      */}
      {ubicada !== undefined && <TaskDetailPanel ubicada={ubicada} />}
    </div>
  );
}
