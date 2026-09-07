import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { BoardDetail, Column, SearchScope } from "../../domain/types.js";
import { cargarTablero, contextoDeTableros, resolverColumnaDelTablero } from "../lookup.js";
import type { EntornoMcp } from "../llamada.js";
import type { TaskManagerPort } from "../port.js";
import { definirHandler, respuesta } from "../respuesta.js";
import type { McpToolDefinition } from "../tool.js";
import { campoBoard, campoColumn, cuentaTareas, tareaJson } from "./campos.js";

const shape = {
  text: z
    .string()
    .describe(
      "Texto a buscar en el titulo y en la descripcion de las tareas. " +
        "Es busqueda de texto completo en espanol: no distingue mayusculas y encuentra la palabra aunque este flexionada ('contrato' encuentra 'contratos'), " +
        "pero no encuentra fragmentos de palabra ni tolera errores de tipeo. Para el titulo exacto de una tarea conocida conviene get_task.",
    ),
  board: campoBoard
    .optional()
    .describe(
      "Tablero al que limitar la busqueda, por id o por nombre. " +
        "Omitido, la busqueda es global: recorre TODOS los tableros, que es como se encuentra una tarea cuando no se recuerda donde estaba.",
    ),
  column: campoColumn
    .optional()
    .describe(
      "Columna a la que limitar la busqueda, por id, key o nombre. Requiere `board`: una columna solo se resuelve dentro de un tablero.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe(
      "Maximo de coincidencias a devolver, entre 1 y 100, de mayor a menor relevancia. Si quedan mas, la respuesta lo indica con has_more.",
    ),
};

/**
 * Una busqueda global devuelve tareas de tableros distintos, y un titulo sin
 * tablero ni columna no es accionable: el agente no sabe donde esta ni a que
 * columna moverla. Por eso se cargan los tableros que aparecieron —tantos como
 * tableros distintos, no como coincidencias.
 */
async function ubicaciones(
  port: TaskManagerPort,
  boardIds: readonly string[],
  yaCargado: BoardDetail | undefined,
): Promise<{ tableros: Map<string, BoardDetail>; columnas: Map<string, Column> }> {
  const tableros =
    yaCargado === undefined
      ? await contextoDeTableros(port, boardIds)
      : new Map([[yaCargado.id, yaCargado]]);

  const columnas = new Map<string, Column>();
  for (const tablero of tableros.values()) {
    for (const columna of tablero.columns) {
      columnas.set(columna.id, columna);
    }
  }
  return { tableros, columnas };
}

export function definirSearchTasks(port: TaskManagerPort, entorno: EntornoMcp): McpToolDefinition {
  return {
    name: "search_tasks",
    title: "Buscar tareas",
    description:
      "Busca tareas por texto en su titulo y en su descripcion, en un tablero o en todos. " +
      "Es la herramienta para 'donde estaba la tarea del contrato': devuelve cada coincidencia con su tablero y su columna, " +
      "asi que despues se puede consultar o mover sin volver a resolver nada. Para ver una columna entera en orden esta list_tasks.",
    inputSchema: shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "search_tasks", shape, async (args, llamada) => {
      if (args.column !== undefined && args.board === undefined) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Falta `board`: una columna solo se resuelve dentro de un tablero.",
          {
            details: { field: "board", column: args.column },
            hint: "Volve a llamar indicando board, o busca en todos los tableros sin column.",
          },
        );
      }

      const tablero =
        args.board === undefined ? undefined : await cargarTablero(port, args.board, llamada);
      const columna =
        tablero === undefined || args.column === undefined
          ? undefined
          : resolverColumnaDelTablero(tablero, args.column, llamada);

      const scope: SearchScope = {
        limit: args.limit,
        ...(tablero === undefined ? {} : { boardId: tablero.id }),
        ...(columna === undefined ? {} : { columnId: columna.id }),
      };
      const pagina = await port.searchTasks(args.text, scope);

      const { tableros, columnas } = await ubicaciones(
        port,
        pagina.items.map((coincidencia) => coincidencia.task.boardId),
        tablero,
      );

      const ambito =
        tablero === undefined
          ? "todos los tableros"
          : columna === undefined
            ? `el tablero "${tablero.name}"`
            : `${columna.key} del tablero "${tablero.name}"`;

      const lineas = [`"${args.text}" en ${ambito}: ${cuentaTareas(pagina.items.length)}.`];
      for (const { task } of pagina.items) {
        const suColumna = columnas.get(task.columnId);
        const suTablero = tableros.get(task.boardId);
        lineas.push(
          `  "${task.title}"  ${suTablero?.name ?? task.boardId} / ${suColumna?.key ?? task.columnId}  ${task.priority}`,
        );
      }
      if (pagina.items.length === 0) {
        lineas.push("  Ninguna coincidencia: proba con otra palabra, o lista el tablero entero.");
      }
      if (pagina.nextCursor !== null) {
        lineas.push(`  Hay mas coincidencias de las que entran en limit=${args.limit}.`);
      }

      return respuesta(lineas, {
        query: args.text,
        tasks: pagina.items.map(({ task, rank }) => ({
          ...tareaJson(task, columnas.get(task.columnId)?.key ?? null),
          board_name: tableros.get(task.boardId)?.name ?? null,
          // Relevancia de PostgreSQL: solo sirve para comparar entre si las
          // coincidencias de esta misma busqueda, no como puntaje absoluto.
          rank,
        })),
        count: pagina.items.length,
        has_more: pagina.nextCursor !== null,
      });
    }),
  };
}
