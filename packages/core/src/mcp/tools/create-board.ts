import { z } from "zod";

import type { CreateBoardInput } from "../../domain/types";
import type { EntornoMcp } from "../llamada";
import type { TaskManagerPort } from "../port";
import { definirHandler, respuesta } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import { columnaJson, cuentaColumnas, tableroJson } from "./campos";

const shape = {
  name: z
    .string()
    .describe(
      "Nombre del tablero, tal como lo diria el usuario. Maximo 120 caracteres y no puede quedar vacio tras recortar espacios. " +
        "Es lo que despues permite referirse al tablero por nombre en el resto de las herramientas, asi que conviene que sea distinto del de los demas.",
    ),
  description: z
    .string()
    .optional()
    .describe("Detalle libre del tablero. Omitido, el tablero queda sin descripcion."),
  columns: z
    .array(
      z.object({
        key: z
          .string()
          .describe(
            "Identificador estable de la columna. Se normaliza a mayusculas y los espacios pasan a guiones bajos: 'en revision' queda EN_REVISION. Unica dentro del tablero.",
          ),
        name: z
          .string()
          .describe("Nombre visible de la columna, el que ve una persona: 'En revision'."),
      }),
    )
    .optional()
    .describe(
      "Columnas del tablero, en el orden en que van a aparecer. " +
        "Omitidas, se crean las cuatro por defecto: BACKLOG (Backlog), TODO (Por hacer), IN_PROGRESS (En progreso) y DONE (Completado). " +
        "Indicalas solo si el usuario pidio un flujo distinto: las cuatro por defecto son las que el resto de las herramientas espera encontrar.",
    ),
};

export function definirCreateBoard(
  port: TaskManagerPort,
  entorno: EntornoMcp,
): McpToolDefinition {
  return {
    name: "create_board",
    title: "Crear tablero",
    description:
      "Crea un tablero con sus columnas. Sin columnas explicitas se crean las cuatro por defecto (BACKLOG, TODO, IN_PROGRESS, DONE), " +
      "asi que el tablero queda listo para recibir tareas en la misma llamada. " +
      "Devuelve el tablero y sus columnas con sus ids y keys, para poder crear tareas a continuacion sin volver a consultar.",
    inputSchema: shape,
    scope: "WRITE",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Dos llamadas iguales crean dos tableros homonimos, y un tablero
      // duplicado convierte toda referencia por nombre en AMBIGUOUS_MATCH.
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: definirHandler(entorno, "create_board", shape, async (args, llamada) => {
      const input: CreateBoardInput = {
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.columns === undefined ? {} : { columns: args.columns }),
      };

      // Un contexto por llamada: el requestId correlaciona ESTA invocacion con
      // el registro de auditoria que deja (5.1).
      const tablero = await port.createBoard(input, llamada.ctx);

      return respuesta(
        [
          "Tablero creado.",
          `  "${tablero.name}"  ${cuentaColumnas(tablero.columns.length)}`,
          `  ${tablero.columns.map((columna) => columna.key).join("  ")}`,
        ],
        {
          board: tableroJson(tablero),
          columns: tablero.columns.map(columnaJson),
        },
      );
    }),
  };
}
