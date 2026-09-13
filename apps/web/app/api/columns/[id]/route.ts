import {
  actualizarColumna,
  columnaConOrden,
  consultaDeBorradoDeColumna,
  parametrosDeColumna,
  type ColumnaConOrden,
} from "@taskman/contracts";
import { crearCorePort, type DeleteColumnOptions, type UpdateColumnInput } from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../lib/auth";
import { aColumnaSalida } from "../../../../lib/columnas";
import {
  leerCuerpo,
  responder,
  responderSinCuerpo,
  respuestaDeError,
  respuestaDeFallo,
} from "../../../../lib/http";
import { registrarContratoRoto } from "../../../../lib/log";

/**
 * PATCH /api/columns/{id} (6.2): renombra o reordena la columna. Scope write.
 * DELETE /api/columns/{id} (6.2): la elimina, con `reassign_to` opcional. Scope
 * delete.
 *
 * Rutas de PRIMER NIVEL y no colgadas del tablero, como las fija la 6.2: el id
 * de una columna ya la identifica sola, y el tablero al que pertenece sale de la
 * propia fila. Pedirlo tambien en la ruta daria dos fuentes del mismo dato,
 * libres de contradecirse, y obligaria a un error nuevo para el caso en que no
 * coincidan.
 *
 * NINGUNA regla de la 5.2 se implementa aca. `ColumnService.update` reubica la
 * columna y reescribe la secuencia COMPLETA del tablero; `ColumnService.delete`
 * exige `reassignTo` si la columna tiene tareas, las mueve al final de la
 * columna destino y reindexa el tablero, TODO en una transaccion. El adaptador
 * valida la forma de la entrada, invoca y traduce.
 */

// Las dos operaciones cambian el orden del tablero: nada que cachear.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

function idInvalido(auth: Parameters<typeof respuestaDeError>[3]): Response {
  return respuestaDeError("VALIDATION_ERROR", "El id de la columna no es un UUID valido.", 400, auth, {
    hint: "Usa el id que devuelve GET /api/boards/{id} o POST /api/boards/{id}/columns.",
  });
}

/**
 * PATCH /api/columns/{id} (6.2). Scope write.
 *
 * DEVUELVE `{ column, columns }`, igual que POST /api/boards/{id}/columns y por
 * el mismo motivo: reordenar una columna reescribe la position de las demas del
 * tablero, asi que devolver solo la columna dejaria al cliente con un orden
 * viejo. Ver `columnaConOrden` para por que la forma es la misma aunque el patch
 * solo renombre.
 */
export const PATCH = conAuth<[ContextoRuta]>("write", async (request, auth, contexto) => {
  const parametros = parametrosDeColumna.safeParse(await contexto.params);

  if (!parametros.success) {
    return idInvalido(auth);
  }

  // El cuerpo se lee por un solo camino, con el tope de 256 KB de la 7.3: ver
  // `leerCuerpo`. Un cuerpo que no es JSON sigue siendo 400; uno que pasa el tope
  // es 413 y no se parsea.
  const leido = await leerCuerpo(request, auth);

  if (!leido.ok) {
    return leido.respuesta;
  }

  const cuerpo = leido.valor;

  const entrada = actualizarColumna.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
      // El 400 mas probable de este endpoint es mandar `key`, que el
      // strictObject rechaza: vale decir por que no se puede.
      hint: "La key de una columna no se puede cambiar: los agentes resuelven referencias con ella.",
    });
  }

  // Los dos campos van condicionales por exactOptionalPropertyTypes, y porque
  // ausente es lo que el nucleo lee como "no tocar": `update` decide con
  // `patch.name !== undefined` y `patch.position !== undefined`.
  const patch: UpdateColumnInput = {
    ...(entrada.data.name === undefined ? {} : { name: entrada.data.name }),
    ...(entrada.data.position === undefined ? {} : { position: entrada.data.position }),
  };

  // Un patch que no cambia nada —`{}`, o el mismo valor que ya estaba— llega
  // igual al nucleo, que lo resuelve como exito sin auditar (5.2). El borde no
  // lo intercepta: seria una segunda definicion de "cambio efectivo".
  //
  // COLUMN_NOT_FOUND, NAME_REQUIRED, NAME_TOO_LONG e INVALID_ORDER salen de aca
  // y los traduce el try/catch de `conAuth` con el mapeo de la 6.4.
  const columna = await taskman.updateColumn(parametros.data.id, patch, contextoDeApi(auth));

  /**
   * El tablero se relee DESPUES de actualizar, y por el id de tablero que trae
   * la columna ya escrita: no viene en la ruta, y tomarlo de una lectura previa
   * seria una consulta de mas para el mismo dato.
   */
  const final = await taskman.getBoard(columna.boardId);

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato que
   * publica. Si deja de cumplirlo es un bug nuestro, asi que es un 500 y no una
   * respuesta a medias.
   */
  const salida = columnaConOrden.safeParse({
    column: aColumnaSalida(columna),
    columns: final.columns.map(aColumnaSalida),
  } satisfies ColumnaConOrden);

  if (!salida.success) {
    registrarContratoRoto(auth.requestId, "PATCH /api/columns/{id}", salida.error.issues);

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});

/**
 * DELETE /api/columns/{id} (6.2). Scope delete.
 *
 * `reassign_to` va en la QUERY, no en el cuerpo; el razonamiento esta en
 * `consultaDeBorradoDeColumna`.
 *
 * 204 SIN CUERPO, igual que DELETE /api/boards/{id} y con su mismo argumento: lo
 * unico que habria para poner en un cuerpo es el recuento de tareas reasignadas,
 * y hoy no se puede sin cambiar el nucleo —`ColumnService.delete` devuelve void y
 * el recuento existe solo dentro del registro de auditoria que escribe—.
 * Devolver en su lugar el orden resultante del tablero obligaria a leerlo DESPUES
 * de la transaccion que borro, o sea a describir un estado de otro instante: el
 * mismo motivo por el que PATCH /api/boards/{id} no devuelve recuentos. Quien
 * necesite el orden nuevo tiene GET /api/boards/{id}, que lo lee todo junto.
 */
export const DELETE = conAuth<[ContextoRuta]>("delete", async (request, auth, contexto) => {
  const parametros = parametrosDeColumna.safeParse(await contexto.params);

  if (!parametros.success) {
    return idInvalido(auth);
  }

  // `?reassign_to=` vacio o con algo que no es un UUID no puede caer en
  // "ausente": seria borrar con el comportamiento que rechaza tareas cuando
  // quien llamo pidio explicitamente reasignarlas. Es el mismo criterio que
  // `?limit=abc` en GET /api/boards.
  const parametrosDeConsulta = new URL(request.url).searchParams;
  const consulta = consultaDeBorradoDeColumna.safeParse({
    reassign_to: parametrosDeConsulta.get("reassign_to") ?? undefined,
  });

  if (!consulta.success) {
    return respuestaDeError("VALIDATION_ERROR", "El parametro reassign_to no es un UUID valido.", 400, auth, {
      details: { issues: consulta.error.issues },
      hint: "Indica el id de otra columna del mismo tablero, o omiti el parametro para borrar una columna vacia.",
    });
  }

  // snake_case -> camelCase en el adaptador (6.1), y condicional porque ausente
  // es justamente lo que el nucleo lee como "no reasignar": con tareas dentro y
  // sin esto, la operacion tiene que fallar con COLUMN_NOT_EMPTY.
  const opciones: DeleteColumnOptions = {
    ...(consulta.data.reassign_to === undefined ? {} : { reassignTo: consulta.data.reassign_to }),
  };

  // COLUMN_NOT_FOUND (404), COLUMN_NOT_EMPTY (409), COLUMN_NOT_IN_BOARD (409) e
  // INVALID_REASSIGN_TARGET (409) salen de aca y los traduce el mapeo de la 6.4.
  await taskman.deleteColumn(parametros.data.id, opciones, contextoDeApi(auth));

  return responderSinCuerpo(auth);
});
