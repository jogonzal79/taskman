import { z } from "zod";

import { cargarTablero } from "../lookup";
import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import { campoBoard, columnaJson, cuentaColumnas, tableroJson } from "./campos";

const shape = {
  board: campoBoard,
  key: z
    .string()
    .describe(
      "Identificador estable de la columna, con el que las demas herramientas la nombran. " +
        "Se normaliza a mayusculas y los espacios pasan a guiones bajos: 'en revision' queda EN_REVISION. " +
        "Tiene que ser unica en el tablero: repetirla devuelve DUPLICATE_KEY.",
    ),
  name: z
    .string()
    .describe(
      "Nombre visible de la columna, el que ve una persona: 'En revision'. Maximo 80 caracteres.",
    ),
  position: z
    .union([z.number().int().min(0), z.literal("end")])
    .default("end")
    .describe(
      "Posicion 0-based de la columna dentro del tablero, o 'end' (por defecto) para agregarla al final. " +
        "Un indice mayor que el numero de columnas se ajusta al final en vez de fallar; las columnas siguientes se desplazan.",
    ),
};

export function definirCreateColumn(
  port: TaskManagerPort,
  entorno: EntornoMcp,
): McpToolDefinition {
  return {
    name: "create_column",
    title: "Crear columna",
    description:
      "Agrega una columna a un tablero existente, en el orden indicado. " +
      "El tablero se puede indicar por nombre, asi que no hace falta consultarlo antes. " +
      "Devuelve el tablero con TODAS sus columnas en su orden final, para poder crear o mover tareas a continuacion.",
    inputSchema: shape,
    scope: "WRITE",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // La key es unica por tablero: la segunda llamada igual da DUPLICATE_KEY,
      // no una segunda columna. No es idempotente, es un error del llamador.
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "create_column", shape, async (args, llamada) => {
      const tablero = await cargarTablero(port, args.board, llamada);

      const columna = await port.createColumn(
        {
          boardId: tablero.id,
          name: args.name,
          key: args.key,
          position: args.position,
        },
        llamada.ctx,
      );

      // Se relee el tablero porque insertar en el medio reescribe la position
      // de las demas: devolver el detalle previo seria devolver un orden viejo.
      const final = await port.getBoard(tablero.id);

      return respuesta(
        [
          "Columna creada.",
          `  ${columna.key}  "${columna.name}"  ${tablero.name}  (posicion ${columna.position})`,
          `  ${tablero.name} tiene ahora ${cuentaColumnas(final.columns.length)}: ${final.columns.map((c) => c.key).join("  ")}`,
        ],
        {
          column: columnaJson(columna),
          board: tableroJson(final),
          columns: final.columns.map(columnaJson),
        },
      );
    }),
  };
}
