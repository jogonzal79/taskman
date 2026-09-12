import { consultaDeBusqueda, listadoDeCoincidencias } from "@taskman/contracts";
import { crearCorePort, type SearchScope } from "@taskman/core";

import { conAuth } from "../../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../../lib/http.js";
import { aTareaSalida } from "../../../../lib/tareas.js";

/**
 * GET /api/tasks/search (6.2, RF-09): busqueda por texto. Scope read.
 *
 * La busqueda NO se implementa aca ni por asomo: `TaskRepository.searchTasks`
 * consulta con `to_tsvector('spanish', title || ' ' || coalesce(description, ''))`
 * —la MISMA expresion del indice GIN de la 4.2, para que el indice se use— contra
 * `plainto_tsquery('spanish', texto)`, ordena por `ts_rank` DESC y pagina por
 * keyset sobre ese rank. El adaptador valida la forma de la consulta, acota el
 * ambito y traduce.
 *
 * Esta ruta vive en `tasks/search/` y no colisiona con `tasks/[id]`: Next
 * resuelve el segmento literal antes que el dinamico, asi que /api/tasks/search
 * nunca llega al handler que espera un UUID. Igual no dependemos de eso para el
 * error: si alguna vez cambiara, `parametrosDeTarea` daria un 400 y no un 500.
 */

// Los resultados describen el estado de las tareas en este momento.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

export const GET = conAuth("read", async (request, auth): Promise<Response> => {
  const parametros = new URL(request.url).searchParams;

  const consulta = consultaDeBusqueda.safeParse({
    limit: parametros.get("limit") ?? undefined,
    cursor: parametros.get("cursor") ?? undefined,
    q: parametros.get("q") ?? undefined,
    board_id: parametros.get("board_id") ?? undefined,
    column_id: parametros.get("column_id") ?? undefined,
  });

  if (!consulta.success) {
    return respuestaDeError(
      "VALIDATION_ERROR",
      "Los parametros de la consulta no superan el esquema.",
      400,
      auth,
      {
        details: { issues: consulta.error.issues },
        hint: "Indica el texto en 'q' y el ambito con 'board_id' o 'column_id'.",
      },
    );
  }

  const scope: SearchScope = {
    limit: consulta.data.limit,
    ...(consulta.data.cursor === undefined ? {} : { cursor: consulta.data.cursor }),
    ...(consulta.data.board_id === undefined ? {} : { boardId: consulta.data.board_id }),
    ...(consulta.data.column_id === undefined ? {} : { columnId: consulta.data.column_id }),
  };

  // El texto va RECORTADO pero sin tocar por lo demas: normalizarlo —bajarlo a
  // minusculas, quitarle acentos— seria adelantarse al diccionario de PostgreSQL,
  // que es el que decide que es un lexema y ya hace su propia normalizacion.
  const pagina = await taskman.searchTasks(consulta.data.q, scope);

  /**
   * La coincidencia es PLANA: los campos de la tarea mas `rank`. Ver
   * `coincidencia` en los contratos para el por que.
   */
  const salida = listadoDeCoincidencias.safeParse({
    items: pagina.items.map(({ task, rank }) => ({ ...aTareaSalida(task), rank })),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de GET /api/tasks/search no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});
