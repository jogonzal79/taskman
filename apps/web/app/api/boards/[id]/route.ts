import {
  actualizarTablero,
  parametrosDeTablero,
  tablero,
  tableroDetallado,
  type ColumnaDetallada,
  type Tablero,
  type TableroDetallado,
} from "@taskman/contracts";
import {
  crearCorePort,
  type Board,
  type BoardWithTaskCounts,
  type ColumnWithTaskCount,
  type UpdateBoardInput,
} from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../lib/auth.js";
import {
  respuestaDeError,
  respuestaDeFallo,
  responder,
  responderSinCuerpo,
} from "../../../../lib/http.js";

/**
 * GET /api/boards/{id} (6.2): el tablero con sus columnas y el recuento de
 * tareas de cada una.
 * PATCH /api/boards/{id} (6.2): actualiza su nombre o su descripcion.
 * DELETE /api/boards/{id} (6.2): lo elimina con sus columnas y tareas.
 *
 * Requieren scope read, write y delete respectivamente (7.2). La autenticacion, el
 * request_id de la 6.1 y la traduccion de errores de dominio a HTTP las aporta
 * `conAuth`: este archivo no arma respuestas de error a mano salvo las que
 * ocurren ANTES de llegar al nucleo, o sea el id malformado y el cuerpo que no
 * es JSON.
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

/**
 * Los campos propios del tablero. Sale aparte porque lo usan los DOS handlers
 * de este archivo —el GET lo envuelve con columnas y recuentos, el PATCH lo
 * devuelve tal cual— y tenerlo dos veces seria dejar que las dos copias se
 * separen en el proximo campo que se le agregue a `board`.
 */
function aTableroSalida(board: Board): Tablero {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    created_at: board.createdAt.toISOString(),
    updated_at: board.updatedAt.toISOString(),
  };
}

function aSalida(board: BoardWithTaskCounts): TableroDetallado {
  return {
    ...aTableroSalida(board),
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


/**
 * PATCH /api/boards/{id} (6.2). Scope write. Patch parcial de nombre y
 * descripcion.
 *
 * DEVUELVE EL TABLERO SOLO, sin columnas ni recuentos, a diferencia del GET de
 * arriba y del POST /api/boards. No es una inconsistencia: es que las tres
 * cosas son distintas. El POST devuelve columnas porque las CREA, y son lo que
 * hace falta para la llamada siguiente; el GET las devuelve porque la 6.2 lo
 * define asi ("Tablero con columnas y recuento"). Un PATCH de nombre y
 * descripcion no toca ninguna columna, y `tablero` —el esquema que ya publica
 * GET /api/boards para cada item de su listado— es exactamente el conjunto de
 * campos que este endpoint puede cambiar.
 *
 * Incluirlas ademas costaria una consulta de mas y seria peor dato: los
 * recuentos NO se pueden dar por cero como en el POST, asi que habria que
 * pedirlos DESPUES de la transaccion que actualizo, y la respuesta mezclaria un
 * tablero de un instante con recuentos de otro. Quien los quiera tiene el GET,
 * que los lee todos juntos.
 */
export const PATCH = conAuth<[ContextoRuta]>("write", async (request, auth, contexto) => {
  const parametros = parametrosDeTablero.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id del tablero no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve GET /api/boards.",
    });
  }

  let cuerpo: unknown;

  try {
    cuerpo = await request.json();
  } catch {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no es JSON valido.", 400, auth, {
      hint: "Envia un cuerpo JSON con 'Content-Type: application/json'.",
    });
  }

  const entrada = actualizarTablero.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
    });
  }

  /**
   * Aca se conservan las DOS intenciones distintas de `description`, y es el
   * punto entero de este handler.
   *
   * El spread condicional no es la ceremonia de exactOptionalPropertyTypes que
   * parece: es lo que mantiene separados "no mandaste el campo" y "lo mandaste
   * en null". Zod omite la clave del opcional ausente, asi que `undefined`
   * significa ausente y nada mas; el spread la deja fuera del patch, y el
   * nucleo la conserva porque decide con `patch.description === undefined`. Un
   * `description: entrada.data.description` liso pondria la clave en undefined
   * en el caso ausente, las dos intenciones llegarian identicas y borrar una
   * descripcion pasaria a ser imposible de pedir.
   */
  const patch: UpdateBoardInput = {
    ...(entrada.data.name === undefined ? {} : { name: entrada.data.name }),
    ...(entrada.data.description === undefined ? {} : { description: entrada.data.description }),
  };

  // Un patch que no cambia nada —`{}`, o el mismo valor que ya estaba— llega
  // igual al nucleo, que lo resuelve como exito sin escribir ni auditar (5.2).
  // El borde no lo intercepta: seria una segunda definicion de "cambio
  // efectivo", libre de separarse de la del nucleo.
  const actualizado = await taskman.updateBoard(parametros.data.id, patch, contextoDeApi(auth));

  const salida = tablero.safeParse(aTableroSalida(actualizado));

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de PATCH /api/boards/{id} no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});


/**
 * DELETE /api/boards/{id} (6.2). Scope delete.
 *
 * SIN PARAMETRO DE CONFIRMACION, y es una decision leida de la
 * especificacion, no un olvido. La 5.2 pide confirmacion explicita para esta
 * operacion "en la capa MCP", nombrando la capa; la 8.3.2 la desarrolla sobre
 * `delete_task` y la controla con MCP_DESTRUCTIVE_POLICY. En todo el capitulo 6
 * la unica mencion es la fila CONFIRMATION_REQUIRED de la 6.4, que es el
 * catalogo de la envoltura de errores y no el contrato de ningun endpoint: ese
 * codigo llega a HTTP por el transporte Streamable de la 8.1 montado en /mcp,
 * igual que DESTRUCTIVE_POLICY_DENIED, que ya esta mapeado sin que REST pueda
 * producirlo. Ni la 6.2 ni la 6.3 piden un `confirm` en el cuerpo o en la query.
 * La contramedida que la 7.2 elige para REST es otra: un scope aparte, y una
 * recomendacion operativa de no darselo a un agente autonomo.
 *
 * 204 SIN CUERPO y no 200 con algo. Lo que habria para poner en un cuerpo es el
 * recuento de lo que se llevo la cascada, y hoy no se puede sin cambiar el
 * nucleo: `BoardService.delete` devuelve void, y el recuento existe solo dentro
 * del registro de auditoria que escribe. Devolver un cuerpo inventado —un `{ok:
 * true}` o el id que el cliente ya mando— no aporta nada que el 204 no diga. Si
 * algun dia el recuento importa en la respuesta, el cambio empieza en la firma
 * del servicio y este endpoint pasa a 200; mientras tanto el 204 es la
 * descripcion honesta de lo que hay.
 *
 * El borrado en cascada NO se arma aca ni en el servicio: lo hacen las FK
 * `onDelete: Cascade` de `board_column.board_id` y `task.board_id`. Este handler
 * solo traduce protocolo.
 */
export const DELETE = conAuth<[ContextoRuta]>("delete", async (_request, auth, contexto) => {
  const parametros = parametrosDeTablero.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id del tablero no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve GET /api/boards.",
    });
  }

  // Un id que ya no existe —porque nunca existio o porque este mismo endpoint lo
  // borro antes— sale por BOARD_NOT_FOUND y lo traduce a 404 el try/catch de
  // `conAuth`. No se intercepta aca para que borrar dos veces no tenga una
  // respuesta distinta de borrar algo inexistente: son el mismo estado.
  await taskman.deleteBoard(parametros.data.id, contextoDeApi(auth));

  return responderSinCuerpo(auth);
});
