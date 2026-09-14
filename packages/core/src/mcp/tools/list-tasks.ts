import { z } from "zod";

import type { Column, ListTasksQuery, Task } from "../../domain/types";
import { cargarTablero, resolverColumnaDelTablero } from "../lookup";
import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import {
  campoBoard,
  campoColumn,
  columnaJson,
  cuentaTareas,
  prioridad,
  tareaJson,
  tareaLinea,
} from "./campos";

const shape = {
  board: campoBoard,
  column: campoColumn
    .optional()
    .describe(
      "Columna a la que limitar el listado, por id, key o nombre. Omitida, se listan las tareas de todas las columnas del tablero.",
    ),
  priority: z
    .array(prioridad)
    .optional()
    .describe(
      "Prioridades a incluir; varias actuan como OR, asi que ['HIGH','URGENT'] devuelve las altas y las urgentes. Omitida, no filtra por prioridad.",
    ),
  overdue: z
    .boolean()
    .optional()
    .describe(
      "true devuelve solo tareas vencidas: con fecha limite anterior a hoy y fuera de la columna DONE. Las tareas sin fecha nunca son vencidas.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe(
      "Maximo de tareas a devolver, entre 1 y 100. Si quedan mas, la respuesta lo indica con has_more: acota por columna o por prioridad en vez de subir el limite a ciegas.",
    ),
};

/**
 * Las tareas del tablero, agrupadas por columna.
 *
 * Se agrupa en el texto y se ordena por (columna, position) en el JSON porque
 * el nucleo ordena por `position` a secas: sin agrupar, un tablero de cuatro
 * columnas devuelve las cuatro primeras tareas juntas, despues las cuatro
 * segundas, y el agente no puede leer el estado de ninguna columna.
 */
function agrupar(tareas: readonly Task[], columnas: readonly Column[]): Map<string, Task[]> {
  const porColumna = new Map<string, Task[]>(columnas.map((columna) => [columna.id, []]));

  for (const tarea of tareas) {
    const lista = porColumna.get(tarea.columnId);
    if (lista === undefined) {
      porColumna.set(tarea.columnId, [tarea]);
    } else {
      lista.push(tarea);
    }
  }

  for (const lista of porColumna.values()) {
    lista.sort((a, b) => a.position - b.position);
  }
  return porColumna;
}

export function definirListTasks(port: TaskManagerPort, entorno: EntornoMcp): McpToolDefinition {
  return {
    name: "list_tasks",
    title: "Listar tareas",
    description:
      "Lista las tareas de un tablero, opcionalmente filtradas por columna, prioridad o vencimiento. " +
      "Devuelve el estado de cada columna en orden, con el id de cada tarea, para poder mover o actualizar despues sin volver a consultar. " +
      "Es la herramienta con la que se resuelve una operacion masiva: primero listar, despues mover una por una.",
    inputSchema: shape,
    scope: "READ",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "list_tasks", shape, async (args, llamada) => {
      const tablero = await cargarTablero(port, args.board, llamada);
      const columna =
        args.column === undefined
          ? undefined
          : resolverColumnaDelTablero(tablero, args.column, llamada);

      const query: ListTasksQuery = {
        boardId: tablero.id,
        limit: args.limit,
        ...(columna === undefined ? {} : { columnId: columna.id }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.overdue === undefined ? {} : { overdue: args.overdue }),
      };
      const pagina = await port.listTasks(query);

      const enAmbito = columna === undefined ? tablero.columns : [columna];
      const porColumna = agrupar(pagina.items, enAmbito);
      const keyDe = new Map(tablero.columns.map((c) => [c.id, c.key]));

      const encabezado =
        columna === undefined
          ? `Tablero "${tablero.name}": ${cuentaTareas(pagina.items.length)}.`
          : `Tablero "${tablero.name}", columna ${columna.key}: ${cuentaTareas(pagina.items.length)}.`;

      const lineas = [encabezado];
      const ordenadas: Task[] = [];
      for (const actual of enAmbito) {
        const tareas = porColumna.get(actual.id) ?? [];
        ordenadas.push(...tareas);
        lineas.push(`  ${actual.key} (${tareas.length})`);
        lineas.push(...tareas.map(tareaLinea));
      }

      if (pagina.nextCursor !== null) {
        lineas.push(
          `  Hay mas tareas de las que entran en limit=${args.limit}: filtra por columna o por prioridad para verlas.`,
        );
      }

      return respuesta(lineas, {
        board: { id: tablero.id, name: tablero.name },
        // Las columnas van siempre: con ellas el agente puede encadenar un
        // move_task por key sin una llamada extra de resolucion.
        columns: tablero.columns.map(columnaJson),
        tasks: ordenadas.map((tarea) => tareaJson(tarea, keyDe.get(tarea.columnId) ?? null)),
        count: ordenadas.length,
        has_more: pagina.nextCursor !== null,
      });
    }),
  };
}
