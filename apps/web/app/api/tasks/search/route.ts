import { consultaDeBusqueda, listadoDeCoincidencias } from "@taskman/contracts";
import { crearCorePort, type SearchScope } from "@taskman/core";

import { conAuth } from "../../../../lib/auth";
import { leerConsulta } from "../../../../lib/consulta";
import { respuestaDeFallo, responder } from "../../../../lib/http";
import { registrarContratoRoto } from "../../../../lib/log";
import { aTareaSalida } from "../../../../lib/tareas";

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
  /**
   * NO hay repetibles aca. `column_key`, que el listado si acepta, es el caso
   * que mas se escribe de memoria contra este endpoint: como el contrato no lo
   * declara, sale con un 400 que lo nombra en vez de quedar inerte y devolver el
   * tablero entero.
   */
  const consulta = leerConsulta(request, consultaDeBusqueda, auth, {
    hint: "Indica el texto en 'q'; acotar con 'board_id' o 'column_id' es opcional.",
  });

  if (!consulta.ok) {
    return consulta.respuesta;
  }

  const scope: SearchScope = {
    limit: consulta.datos.limit,
    ...(consulta.datos.cursor === undefined ? {} : { cursor: consulta.datos.cursor }),
    ...(consulta.datos.board_id === undefined ? {} : { boardId: consulta.datos.board_id }),
    ...(consulta.datos.column_id === undefined ? {} : { columnId: consulta.datos.column_id }),
  };

  // El texto va RECORTADO pero sin tocar por lo demas: normalizarlo —bajarlo a
  // minusculas, quitarle acentos— seria adelantarse al diccionario de PostgreSQL,
  // que es el que decide que es un lexema y ya hace su propia normalizacion.
  const pagina = await taskman.searchTasks(consulta.datos.q, scope);

  /**
   * La coincidencia es PLANA: los campos de la tarea mas `rank`. Ver
   * `coincidencia` en los contratos para el por que.
   */
  const salida = listadoDeCoincidencias.safeParse({
    items: pagina.items.map(({ task, rank }) => ({ ...aTareaSalida(task), rank })),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    registrarContratoRoto(auth.requestId, "GET /api/tasks/search", salida.error.issues);

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});
