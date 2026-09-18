import { BoardHeader } from "../components/board-header";
import { BoardSidebar } from "../components/board-sidebar";
import { ColumnList } from "../components/column-list";
import { TaskDetailPanel } from "../components/task-detail-panel";
import {
  enlaceTablero,
  leerFiltros,
  leerTableroElegido,
  leerTareaAbierta,
} from "../lib/filtros";
import { cargarVista, paraLaPantalla, ubicarEnVista } from "../lib/tablero";

/**
 * El tablero (9.1, 9.3): la lectura, y desde aca cuelgan todas las escrituras de
 * la UI —crear tableros y tareas, editar, borrar y mover—, que son Server
 * Actions (`lib/acciones.ts`) disparadas desde componentes de cliente.
 *
 * ESTA PAGINA ES UN SERVER COMPONENT, y se puede comprobar sin creerlo: la
 * funcion es `async` y espera al nucleo, cosa que un Componente de Cliente no
 * puede ser; el modulo llega por `lib/tablero.ts` hasta `@taskman/core` y de ahi
 * a `pg`, que en el bundle del navegador no compila. Del lado empirico: el HTML
 * que devuelve el servidor ya trae las columnas y las tarjetas.
 *
 * EL LIMITE CLIENTE/SERVIDOR CAE EN `ColumnList`, que es de cliente desde que
 * entro dnd-kit, y con el se llevo `ColumnCard` y `TaskCard`. Estaba anunciado
 * desde el modo lectura —"el contexto de arrastre vive en ColumnList, y por eso
 * ColumnList ya es una pieza aparte"— y es la razon de que mover el limite haya
 * sido cambiar un import y no rehacer la pagina.
 *
 * LO QUE CRUZA es el tablero SIN las descripciones (`paraLaPantalla`). React
 * serializa en la carga RSC todo lo que se le pasa a un componente de cliente,
 * lo lea o no, asi que sin esa proyeccion la descripcion entera de cada tarea
 * viajaria al navegador para no pintarse en ningun sitio. Lo unico que sigue
 * cruzando con descripcion es la tarea ABIERTA en el panel.
 *
 * El aviso de pantalla angosta, que en la 9.3 habria sido el otro candidato a
 * cliente, se resolvio con una media query y sigue sin necesitar JavaScript.
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
 * TODO EL ESTADO DE LA PANTALLA VIVE EN LA URL: que tablero se esta viendo
 * (`?tablero=<id>`), que tarea esta abierta (`?tarea=<id>`) y que filtros hay
 * puestos (`?prioridad=...&vencidas=1`). Ver `lib/filtros.ts` para lo que resuelve
 * cada uno; lo que comparten es lo importante: los tres se resuelven en el
 * SERVIDOR, conviven en la misma cadena y ninguno pisa a otro, porque todos los
 * enlaces de la pagina salen de `enlaceTablero`, que no compila sin el tablero.
 *
 * Los parametros hay que LEERLOS ANTES de cargar la vista, porque los filtros son
 * parte de la consulta: no se trae el tablero entero para esconder tarjetas.
 */
export default async function PaginaTablero({
  searchParams,
}: {
  // En Next 16 los parametros de consulta llegan como Promise, igual que los de
  // ruta en un Route Handler.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hoy = new Date();
  const parametros = await searchParams;
  const filtros = leerFiltros(parametros);
  const tareaAbierta = leerTareaAbierta(parametros);

  const { tableros, tablerosOmitidos, actual, inexistente } = await cargarVista(
    hoy,
    filtros,
    leerTableroElegido(parametros),
  );

  /**
   * LA BARRA SE DIBUJA SIEMPRE, tambien sin tablero que mostrar. Antes no —"sin
   * tableros estaria vacia al lado de un hueco"— y desde que crea tableros es al
   * reves: sin ningun tablero es el UNICO sitio de la pantalla desde donde crear
   * el primero, y con un tablero pedido que no existe es donde se elige otro.
   */
  const barra = (
    <BoardSidebar tableros={tableros} omitidos={tablerosOmitidos} filtros={filtros} />
  );

  /**
   * UN TABLERO PEDIDO QUE NO EXISTE NO CAE AL PRIMERO, y es la diferencia con un
   * `?tarea=` que no apunta a nada, que dibuja el tablero sin panel. La falta de
   * un panel se ve sola; otro tablero en su lugar no: quien abre un enlace a un
   * tablero borrado y ve otro con columnas y tareas puede no darse cuenta de que el
   * suyo ya no esta. Seria el parametro INERTE que los listados REST rechazan con
   * 400 (`leerConsulta`), con la diferencia de que aca la pantalla SI puede
   * decirlo, asi que no hace falta rechazar: se muestra el aviso. Ni 404 ni 500:
   * un enlace viejo no es un fallo del sistema.
   */
  if (actual === undefined) {
    return (
      <div className="marco">
        {barra}
        <main className="pagina">
          <p className="sin-tablero">
            {inexistente
              ? "Ese tablero no existe: puede que se haya borrado o que el enlace este mal copiado. Elegi otro en la barra de la izquierda."
              : 'No hay ningun tablero todavia. Crea el primero con "Nuevo tablero", en la barra de la izquierda.'}
          </p>
        </main>
      </div>
    );
  }

  /**
   * La tarea del panel se busca DENTRO del tablero ya cargado, sin consultar. Un
   * id inexistente, uno de otro tablero o el de una tarea que se acaba de borrar
   * dan `undefined` y la pagina dibuja el tablero sin panel: un enlace viejo en
   * la barra de direcciones no es un error del sistema. Ver `ubicarEnVista`.
   */
  const ubicada = ubicarEnVista(actual, tareaAbierta);

  /**
   * Lo que se muestra, sumado sobre las columnas. Con filtro es menos que
   * `actual.taskCount`, y la diferencia entre los dos es exactamente lo que el
   * filtro esta escondiendo. Se cuenta sobre lo cargado y no en la base a
   * proposito: es el numero que describe LA PANTALLA, y el que describe el
   * tablero ya lo da el agregado.
   */
  const mostradas = actual.columns.reduce((suma, columna) => suma + columna.tasks.length, 0);

  return (
    <div className="marco">
      {barra}
      <main className="pagina">
        <BoardHeader
          boardId={actual.id}
          nombre={actual.name}
          taskCount={actual.taskCount}
          mostradas={mostradas}
          filtros={filtros}
          tareaAbierta={tareaAbierta}
        />
        <ColumnList
          boardId={actual.id}
          columnas={paraLaPantalla(actual.columns)}
          hoy={hoy}
          // El id del parametro y no el de `ubicada`: si apunta a nada, no hay
          // tarjeta que marcar y las dos formas coinciden. Con `ubicada` habria
          // que desenvolverlo para lo mismo.
          tareaAbierta={tareaAbierta}
          filtros={filtros}
        />
      </main>
      {/*
        HERMANO del `<main>`, no encima: el panel se abre al costado y el
        tablero se estrecha. Es la diferencia entre un panel y un modal, y es
        por eso que no hay capa, ni superposicion, ni foco atrapado.

        `hrefCerrar` se calcula ACA y baja como cadena: cerrar el panel es volver
        a ESTE tablero CON LOS FILTROS PUESTOS, y el componente de cliente que
        tambien cierra (con Escape, y despues de borrar) no puede leer los
        parametros del servidor. Pasar la cadena ya armada es lo que hace que las
        tres formas de cerrar —el enlace, Escape y el borrado— vayan al mismo
        sitio.
      */}
      {ubicada !== undefined && (
        <TaskDetailPanel ubicada={ubicada} hrefCerrar={enlaceTablero(actual.id, filtros)} />
      )}
    </div>
  );
}
