import {
  moverTarea,
  parametrosDeTarea,
  resultadoDeMovimiento,
  type ResultadoDeMovimiento,
} from "@taskman/contracts";
import { crearCorePort, type MoveResult, type MoveTarget } from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../../lib/auth.js";
import { leerCuerpo, responder, respuestaDeError, respuestaDeFallo } from "../../../../../lib/http.js";
import { registrarContratoRoto } from "../../../../../lib/log.js";
import { aTareaSalida } from "../../../../../lib/tareas.js";

/**
 * POST /api/tasks/{id}/move (6.2, 6.3.3, RF-07 y RF-08): mueve una tarea a otra
 * columna del mismo tablero, o la reordena dentro de la suya. Scope write.
 *
 * NADA del algoritmo de la 5.4 vive aca, y es el endpoint donde mas importa
 * decirlo: la transaccion REPEATABLE READ, el bloqueo de las filas de las dos
 * columnas en orden canonico, el recalculo del orden en memoria, la reescritura
 * de la secuencia completa 0..n-1 de cada columna afectada y los reintentos
 * ante 40001 son de `TaskService.move`. Mover DENTRO de la misma columna
 * tampoco es un caso aparte aca, por la misma razon por la que no lo es alla:
 * es el mismo saca-e-inserta con origen igual a destino.
 *
 * El adaptador valida la forma del cuerpo, traduce y responde.
 */

// El orden que devuelve esta respuesta es el de este instante y lo acaba de
// cambiar esta misma peticion.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

/**
 * La traduccion camelCase -> snake_case del resultado (6.1).
 *
 * `task_order` se copia TAL CUAL lo devuelve el nucleo, que lo releyo de la
 * base despues de escribir: no se reordena, ni se recalcula, ni se deriva de la
 * tarea movida. Si el adaptador lo reconstruyera a partir de lo que cree que
 * paso, la UI reconciliaria con un orden que nadie garantizo (9.2).
 */
function aSalida(resultado: MoveResult): ResultadoDeMovimiento {
  return {
    task: aTareaSalida(resultado.task),
    from_column_id: resultado.fromColumnId,
    to_column_id: resultado.toColumnId,
    affected_columns: resultado.affectedColumns.map((columna) => ({
      column_id: columna.columnId,
      task_order: columna.taskOrder,
    })),
  };
}

export const POST = conAuth<[ContextoRuta]>("write", async (request, auth, contexto) => {
  const parametros = parametrosDeTarea.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id de la tarea no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve POST /api/tasks.",
    });
  }

  // El cuerpo se lee por un solo camino, con el tope de 256 KB de la 7.3: ver
  // `leerCuerpo`. Un cuerpo que no es JSON sigue siendo 400; uno que pasa el tope
  // es 413 y no se parsea.
  const leido = await leerCuerpo(request, auth);

  if (!leido.ok) {
    return leido.respuesta;
  }

  const cuerpo = leido.valor;

  const entrada = moverTarea.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
    });
  }

  /**
   * Los dos opcionales van condicionales por exactOptionalPropertyTypes, igual
   * que en el create. `position` no: es obligatoria en el cuerpo y obligatoria
   * en `MoveTarget`, asi que siempre hay un valor que pasar.
   *
   * Una position NEGATIVA no llega hasta aca: la para el `min(0)` del esquema,
   * con el campo nombrado en los issues. El nucleo tiene su propia guarda
   * —`assertValidPosition`, que lanza INVALID_ORDER— y las dos dan 400; la del
   * borde llega primero y dice cual es el campo.
   */
  const target: MoveTarget = {
    ...(entrada.data.column_id === undefined ? {} : { columnId: entrada.data.column_id }),
    ...(entrada.data.column_key === undefined ? {} : { columnKey: entrada.data.column_key }),
    position: entrada.data.position,
  };

  // TASK_NOT_FOUND (404), COLUMN_NOT_FOUND (404), COLUMN_NOT_IN_BOARD (409) e
  // INVALID_ORDER (400) salen de aca como DomainError y los traduce el
  // try/catch de `conAuth` con el mapeo de la 6.4. Una position MAYOR que el
  // tamano de la columna destino no es ninguno de esos: la 5.2 pide que se
  // ajuste al final en vez de fallar, y eso lo hace `computeMoveOrder`.
  const resultado = await taskman.moveTask(
    parametros.data.id,
    target,
    contextoDeApi(auth),
  );

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato
   * que publica. Aca ademas atrapa el `affected_columns` vacio, que seria un
   * movimiento que no afecto ninguna columna: imposible por construccion, y por
   * eso mismo un 500 nuestro y no un cuerpo a medias.
   */
  const salida = resultadoDeMovimiento.safeParse(aSalida(resultado));

  if (!salida.success) {
    registrarContratoRoto(auth.requestId, "POST /api/tasks/{id}/move", salida.error.issues);

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  // 200 y no 201: el movimiento no crea ningun recurso, y la 6.3.3 lo escribe
  // asi.
  return responder(salida.data, 200, auth);
});
