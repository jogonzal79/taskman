import {
  parametrosDeTablero,
  tableroDetallado,
  type ColumnaDetallada,
  type TableroDetallado,
} from "@taskman/contracts";
import { crearCorePort, type BoardWithTaskCounts, type ColumnWithTaskCount } from "@taskman/core";

import { conAuth } from "../../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../../lib/http.js";

/**
 * GET /api/boards/{id} (6.2): el tablero con sus columnas y el recuento de
 * tareas de cada una.
 *
 * Requiere scope read (7.2). La autenticacion, el request_id de la 6.1 y la
 * traduccion de errores de dominio a HTTP las aporta `conAuth`: este archivo no
 * arma ninguna respuesta de error a mano salvo la del id malformado, que es la
 * unica que ocurre antes de llegar al nucleo.
 */

// Un tablero cacheado responde por el estado de otro momento.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();


/** La traduccion camelCase -> snake_case vive en el adaptador (6.1). */
function aColumnaSalida(columna: ColumnWithTaskCount): ColumnaDetallada {
  return {
    id: columna.id,
    board_id: columna.boardId,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    task_count: columna.taskCount,
    created_at: columna.createdAt.toISOString(),
    updated_at: columna.updatedAt.toISOString(),
  };
}

function aSalida(board: BoardWithTaskCounts): TableroDetallado {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    created_at: board.createdAt.toISOString(),
    updated_at: board.updatedAt.toISOString(),
    columns: board.columns.map(aColumnaSalida),
    task_count: board.taskCount,
  };
}

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

export const GET = conAuth<[ContextoRuta]>("read", async (request, auth, contexto) => {
  const parametros = parametrosDeTablero.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id del tablero no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve GET /api/boards.",
    });
  }

  // Lo que lance el nucleo —BOARD_NOT_FOUND, entre otros— lo traduce el
  // try/catch de `conAuth` con el mapeo de la 6.4. Envolverlo aca duplicaria esa
  // decision y dejaria dos lugares donde puede divergir.
  const tablero = await taskman.getBoardWithTaskCounts(parametros.data.id);

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato que
   * publica. Si deja de cumplirlo es un bug nuestro, asi que es un 500 y no una
   * respuesta a medias: devolver el cuerpo igual convertiria un error detectado
   * en uno silencioso que rompe al cliente mas lejos.
   */
  const salida = tableroDetallado.safeParse(aSalida(tablero));

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de GET /api/boards/{id} no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});
