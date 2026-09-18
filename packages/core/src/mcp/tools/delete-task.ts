import { z } from "zod";

import { DomainError } from "../../domain/errors";
import type { BoardDetail, Column, Task } from "../../domain/types";
import { ordenDeColumna, ubicarTarea } from "../lookup";
import type { EntornoMcp } from "../llamada";
import type { PoliticaDestructiva } from "../politica";
import type { TaskManagerPort } from "../port";
import { definirHandler, fechaIso, respuesta, respuestaError } from "../respuesta";
import type { McpToolDefinition } from "../tool";
import {
  campoBoardDeTarea,
  campoTask,
  columnaJson,
  cuentaTareas,
  tableroJson,
  tareaJson,
} from "./campos";

/**
 * La unica herramienta destructiva del catalogo (8.2), con la politica de
 * confirmacion de la 8.3.2.
 *
 * Las tres politicas no son tres modos de la misma herramienta: son tres
 * herramientas distintas para el agente, y por eso la descripcion y el esquema
 * se arman por politica. Un agente que lee "esto borra de inmediato" planifica
 * distinto que uno que lee "esto devuelve la tarea y espera confirmacion"; dar
 * la misma descripcion en los dos casos lo obligaria a descubrir cual es por
 * ensayo y error, y el ensayo aca borra una tarea.
 */

const DETALLE_QUE_DESAPARECE =
  "Antes de borrar devuelve el detalle completo de la tarea —titulo, columna, prioridad, vencimiento y descripcion— para que puedas mostrarle al usuario exactamente que va a desaparecer.";

const DESCRIPCIONES: Record<PoliticaDestructiva, string> = {
  confirm:
    "Elimina una tarea. El borrado es definitivo: no hay papelera ni deshacer. " +
    "Son DOS llamadas: la primera, sin confirm, no borra nada y devuelve CONFIRMATION_REQUIRED con la tarea entera; " +
    "la segunda, con confirm: true, la elimina. " +
    `${DETALLE_QUE_DESAPARECE} No confirmes por tu cuenta: la confirmacion es del usuario.`,
  allow:
    "Elimina una tarea. El borrado es definitivo: no hay papelera ni deshacer. " +
    "Este servidor esta configurado para borrar sin confirmacion (MCP_DESTRUCTIVE_POLICY=allow), asi que la llamada elimina la tarea de inmediato: " +
    "preguntale al usuario ANTES de llamar, porque la herramienta ya no va a preguntar. " +
    "Si necesitas ver que vas a borrar, llama primero a get_task.",
  deny:
    "Eliminaria una tarea, pero este servidor tiene el borrado desactivado (MCP_DESTRUCTIVE_POLICY=deny) y la herramienta no se ofrece. " +
    "Cualquier invocacion falla sin tocar la base.",
};

const CONFIRM: Record<PoliticaDestructiva, string> = {
  confirm:
    "Confirmacion explicita del borrado, que tiene que venir del usuario y no de vos. " +
    "Sin `confirm: true` la herramienta NO borra: devuelve CONFIRMATION_REQUIRED con la tarea entera para que se la muestres y vuelvas a llamar solo si la confirma.",
  allow:
    "Se acepta pero se ignora: este servidor esta configurado para borrar sin confirmacion (MCP_DESTRUCTIVE_POLICY=allow). " +
    "Mandarlo en false NO impide el borrado.",
  deny: "Irrelevante: este servidor tiene el borrado desactivado y la llamada falla venga como venga.",
};

/**
 * El detalle que la 8.3.2 pide mostrar antes de borrar. Es el mismo bloque que
 * imprime get_task a proposito: lo que el usuario ve al confirmar tiene que ser
 * identico a lo que veria al consultar, o la confirmacion no prueba nada.
 */
function detalleDeTarea(tarea: Task, tablero: BoardDetail, columna: Column | undefined): string[] {
  const vence = fechaIso(tarea.dueDate);
  return [
    `  "${tarea.title}"`,
    `  ${tablero.name} / ${columna?.key ?? tarea.columnId}  (posicion ${tarea.position})`,
    `  Prioridad ${tarea.priority}${vence === null ? "" : `  vence ${vence}`}`,
    tarea.description === null ? "  Sin descripcion." : `  ${tarea.description}`,
  ];
}

export function definirDeleteTask(
  port: TaskManagerPort,
  entorno: EntornoMcp,
  politica: PoliticaDestructiva,
): McpToolDefinition {
  const shape = {
    task: campoTask("a eliminar"),
    board: campoBoardDeTarea,
    confirm: z.boolean().default(false).describe(CONFIRM[politica]),
  };

  return {
    name: "delete_task",
    title: "Eliminar tarea",
    description: DESCRIPCIONES[politica],
    inputSchema: shape,
    // DELETE con las tres politicas, tambien con `deny`: el scope dice que
    // necesita la clave de quien llama (7.2) y la politica que permite el
    // servidor (8.3.2). Son dos filtros independientes.
    scope: "DELETE",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // NO es idempotente, y no por el TASK_NOT_FOUND de la segunda llamada:
      // si la tarea vino por titulo, repetir los mismos argumentos puede
      // resolver a OTRA tarea homonima y borrarla tambien. Anunciarla como
      // idempotente invitaria a un cliente a reintentar por su cuenta.
      idempotentHint: false,
      openWorldHint: false,
    },
    // Con `deny` la herramienta existe pero no se ofrece (8.1): el filtrado va
    // en el listado y no solo en la ejecucion, para que el agente no planifique
    // un borrado que no puede completar.
    anunciada: politica !== "deny",
    handler: definirHandler(entorno, "delete_task", shape, async (args, llamada) => {
      if (politica === "deny") {
        // Antes de resolver nada: si no se puede borrar, leer la base para
        // averiguar QUE no se puede borrar no le sirve a nadie.
        throw new DomainError(
          "DESTRUCTIVE_POLICY_DENIED",
          "Este servidor no elimina tareas: MCP_DESTRUCTIVE_POLICY=deny.",
          {
            details: { policy: "deny", variable: "MCP_DESTRUCTIVE_POLICY", task: args.task },
            hint: "No hay forma de borrarla desde aca, y reintentar con confirm: true tampoco cambia nada. Decile al usuario que la tarea sigue existiendo y que el borrado esta desactivado en la configuracion del servidor.",
          },
        );
      }

      const { tablero, taskId } = await ubicarTarea(port, args.task, args.board, llamada);
      const tarea = await port.getTask(taskId);

      // `ubicarTarea` no comprueba que un id de tarea pertenezca al `board` que
      // le pasaron: la resolucion por id no busca. Para el detalle eso importa
      // mas que en otras herramientas —una confirmacion que nombra el tablero
      // equivocado y ninguna columna es peor que no confirmar— asi que el
      // detalle sale SIEMPRE del tablero real de la tarea.
      const real = tarea.boardId === tablero.id ? tablero : await port.getBoard(tarea.boardId);
      const columna = real.columns.find((candidata) => candidata.id === tarea.columnId);

      if (politica === "confirm" && !args.confirm) {
        return respuestaError(
          {
            code: "CONFIRMATION_REQUIRED",
            message: "No se borro nada todavia. Esto eliminaria la tarea de forma definitiva:",
            details: {
              field: "confirm",
              task: tareaJson(tarea, columna?.key ?? null),
              board: tableroJson(real),
              column: columna === undefined ? null : columnaJson(columna),
            },
            // El id resuelto, no el `task` original: si vino un titulo, la
            // segunda llamada tiene que apuntar a ESTA tarea y no volver a
            // resolver un nombre que mientras tanto puede empatar con otra.
            hint: `Mostrale al usuario la tarea de arriba. Si la confirma, volve a llamar a delete_task con task=${JSON.stringify(tarea.id)} y confirm: true. Si no la confirma, no vuelvas a llamar.`,
          },
          llamada.ctx.requestId,
          detalleDeTarea(tarea, real, columna),
        );
      }

      // El contexto existe desde el principio de la invocacion, pero recien aca
      // se USA: la primera llamada de la 8.3.2 no borra nada, y una
      // confirmacion pendiente no es una escritura que auditar. En el log si
      // aparece, con su outcome CONFIRMATION_REQUIRED y el mismo requestId.
      await port.deleteTask(taskId, llamada.ctx);

      // El orden final de la columna, leido despues del borrado: es lo que le
      // permite al agente encadenar sin volver a listar, y de paso es la unica
      // forma de que la respuesta muestre que el orden quedo denso.
      const orden = await ordenDeColumna(port, real.id, tarea.columnId);
      const key = columna?.key ?? tarea.columnId;

      return respuesta(
        [
          "Tarea eliminada.",
          `  "${tarea.title}"  ${real.name} / ${key}`,
          `  ${key} contiene ahora ${cuentaTareas(orden.length)}.`,
        ],
        {
          // `deleted_task` y no `task`: el resto de las herramientas devuelve en
          // `task` algo que todavia existe, y reusar la clave para una tarea que
          // ya no esta invitaria a encadenar una llamada sobre un id muerto.
          deleted_task: tareaJson(tarea, columna?.key ?? null),
          board: tableroJson(real),
          column: {
            ...(columna === undefined
              ? { id: tarea.columnId, key: null, name: null, position: null }
              : columnaJson(columna)),
            task_order: orden,
          },
        },
      );
    }),
  };
}
