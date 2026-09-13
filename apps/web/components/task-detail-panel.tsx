import Link from "next/link";

import type { TareaUbicada } from "../lib/tablero";
import { aFechaIso } from "../lib/tareas";
import { TaskEditor } from "./task-editor";

/**
 * TaskDetailPanel (9.3): "Panel lateral de edicion; guardado por campo al perder
 * el foco."
 *
 * PANEL LATERAL Y NO MODAL, que es una decision de producto y no de estilo. Un
 * modal tapa el tablero y obliga a cerrarlo para ver donde estabas; el panel se
 * abre al costado y deja las columnas a la vista, que es justo lo que hace falta
 * mientras se edita para decidir a donde va la tarea. El `<aside>` es hermano del
 * `<main>` en el marco flex, asi que las columnas se estrechan y ninguna
 * desaparece: no hay superposicion, no hay capa, no hay foco atrapado.
 *
 * ESTE COMPONENTE ES DE SERVIDOR. Lo unico de cliente es `TaskEditor`, que es lo
 * que necesita eventos: el estado de cada campo, el blur que guarda y la tecla
 * Escape. La cabecera, el nombre de la columna y el cierre se dibujan aca, y el
 * cierre es un ENLACE y no un boton porque cerrar el panel es navegar.
 *
 * EL PANEL ESTA EN LA URL, no en estado de cliente: `/?tarea=<id>`. Tres cosas
 * salen gratis de esa decision y ninguna era obvia:
 *
 *   - Los datos no cruzan al cliente. La pagina resuelve la tarea en el servidor
 *     con lo que ya cargo (`ubicarEnVista`), asi que abrir el panel no manda el
 *     tablero al navegador ni dispara una consulta nueva.
 *   - Una edicion repinta el panel Y la tarjeta con una sola revalidacion: el
 *     panel es un parametro de consulta de la MISMA ruta que `revalidatePath("/")`
 *     invalida. Con el panel en estado de cliente habria que sincronizar dos
 *     copias del mismo dato.
 *   - Un enlace a una tarea concreta se puede compartir y sobrevive a un recargado.
 *
 * El precio es un viaje al servidor por apertura. Con la pagina ya cargada es un
 * render parcial, no una carga de documento.
 *
 * EL `key` DEL EDITOR es el id de la tarea MAS sus cuatro valores, y no es
 * decorativo: los campos del editor guardan estado propio mientras se escribe
 * (`useState(valorInicial)`), asi que un valor nuevo llegado por revalidacion no
 * entraria en un campo ya montado. Con este `key`, un cambio hecho por otro actor
 * —un agente por MCP, otra pestana— remonta el editor con los valores frescos en
 * vez de dejar la pantalla mostrando lo viejo. Y como el `key` cambia solo cuando
 * cambia algun valor, escribir en un campo no remonta nada.
 */
export function TaskDetailPanel({ ubicada }: { ubicada: TareaUbicada }) {
  const { tarea, columna } = ubicada;

  // `AAAA-MM-DD` leido en UTC, que es lo que espera un `<input type="date">`.
  // `aFechaIso` es la MISMA conversion que usa el borde REST para serializar
  // `due_date`: la columna es DATE y leerla en la zona del proceso (UTC-4)
  // mostraria el dia anterior.
  const dueDate = aFechaIso(tarea.dueDate) ?? "";

  return (
    <aside className="panel" aria-label={`Detalle de ${tarea.title}`}>
      <header className="panel__cabecera">
        <h2 className="panel__titulo">Detalle</h2>
        {/*
          Cerrar es NAVEGAR a la misma ruta sin el parametro, asi que es un
          enlace: funciona con el teclado, con el boton del medio y sin
          JavaScript. El mismo destino que usa Escape dentro del editor.
        */}
        <Link className="panel__cerrar" href="/" scroll={false} aria-label="Cerrar el detalle">
          Cerrar
        </Link>
      </header>

      <TaskEditor
        key={`${tarea.id}:${tarea.title}:${tarea.description ?? ""}:${tarea.priority}:${dueDate}`}
        tarea={{
          id: tarea.id,
          title: tarea.title,
          description: tarea.description,
          priority: tarea.priority,
          dueDate,
        }}
        columnName={columna.name}
      />
    </aside>
  );
}
