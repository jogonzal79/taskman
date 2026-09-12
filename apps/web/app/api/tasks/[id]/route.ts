import {
  actualizarTarea,
  parametrosDeTarea,
  tarea as esquemaDeTarea,
  type Tarea,
} from "@taskman/contracts";
import { crearCorePort, type UpdateTaskInput } from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../lib/auth.js";
import {
  respuestaDeError,
  respuestaDeFallo,
  responder,
  responderSinCuerpo,
} from "../../../../lib/http.js";
import { aFechaUtc, aTareaSalida } from "../../../../lib/tareas.js";

/**
 * GET /api/tasks/{id} (6.2): consulta una tarea. Scope read.
 * PATCH /api/tasks/{id} (6.2, RF-05): actualiza sus campos editables. Scope write.
 * DELETE /api/tasks/{id} (6.2, RF-06): la elimina. Scope delete.
 *
 * NINGUNA regla de la 5.2 se implementa aca. El patch parcial, el "sin cambio
 * efectivo es exito sin auditoria" y la reindexacion de la columna tras el
 * borrado son de `TaskService`; el adaptador valida la forma del cuerpo,
 * traduce y responde.
 *
 * El GET no recibe `ActorContext` y no es un olvido: la 7.4 no audita las
 * lecturas, y `contextoDeApi` existe solo para las escrituras. Es la misma
 * asimetria que tienen los servicios y el puerto.
 */

// Una tarea cacheada responde por el estado de otro momento.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/**
 * Los campos que un cliente va a intentar cambiar con un PATCH y que NO se
 * cambian con un PATCH.
 *
 * No estan en `actualizarTarea`, asi que el `strictObject` ya los rechaza con
 * un 400 sin que este archivo haga nada: la lista existe solo para reconocerlos
 * entre las claves sobrantes y agregarle al error el HINT que la 5.3 pide, o
 * sea la llamada que si hace lo que quien llamo queria. Sin el, el cuerpo del
 * 400 dice que `position` no se reconoce y deja al cliente adivinando si el
 * campo se llama de otra forma o si la operacion no existe.
 *
 * `column_key` va junto a `column_id` porque es el mismo pedido por otra
 * referencia, y move acepta las dos formas (6.3.3).
 */
const A_MOVE = new Set(["position", "column_id", "column_key"]);

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

export const GET = conAuth<[ContextoRuta]>("read", async (_request, auth, contexto) => {
  const parametros = parametrosDeTarea.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id de la tarea no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve POST /api/tasks.",
    });
  }

  // TASK_NOT_FOUND lo lanza el nucleo y lo traduce a 404 el try/catch de
  // `conAuth` con el mapeo de la 6.4.
  const tarea = await taskman.getTask(parametros.data.id);

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato que
   * publica. En esta tarea tiene un trabajo concreto ademas del general: el
   * esquema de `due_date` es `AAAA-MM-DD` estricto, asi que una conversion de zona
   * horaria que corriera el dia o dejara pasar un ISO completo no llega al
   * cliente, se convierte en un 500 nuestro.
   */
  const salida = esquemaDeTarea.safeParse(aTareaSalida(tarea) satisfies Tarea);

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de GET /api/tasks/{id} no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});

/**
 * PATCH /api/tasks/{id} (6.2, RF-05). Scope write.
 *
 * POSITION Y COLUMN_ID SE RECHAZAN CON 400, y es la decision de este endpoint.
 *
 * La alternativa era dejarlos pasar al nucleo, y ahi esta el motivo de no
 * hacerlo: `UpdateTaskInput` no los tiene, y `TaskService.update` lee campo por
 * campo los cuatro que si tiene. O sea que el nucleo no los rechaza, los
 * IGNORA. Un `position` que llegara hasta ahi devolveria 200 con la tarea sin
 * mover y sin ninguna senal de que lo pedido no ocurrio, que es el peor
 * resultado posible: el cliente se entera recien cuando alguien nota que la
 * tarea sigue donde estaba. La defensa de la regla es del BORDE y no del tipo;
 * el tipo la sostiene contra nosotros —un literal con `position` no compila—
 * pero no contra un cuerpo JSON, que no pasa por el compilador.
 *
 * Rechazarlos no cuesta codigo: no estan en `actualizarTarea` y el
 * `strictObject` los saca por `unrecognized_keys`. Lo unico que agrega este
 * handler es el hint con la llamada a move, que es lo que convierte el error en
 * una instruccion ejecutable (5.3).
 *
 * DEVUELVE LA TAREA SOLA, siguiendo el precedente de POST /api/tasks y la
 * 6.3.1: el unico cuerpo que la especificacion escribe campo por campo para una
 * tarea es ese, y los cuatro campos que este endpoint puede cambiar estan todos
 * adentro. Ninguno de ellos toca el orden de la columna, asi que aca no hay
 * nada equivalente al `columns` que devuelven los endpoints de columna.
 */
export const PATCH = conAuth<[ContextoRuta]>("write", async (request, auth, contexto) => {
  const parametros = parametrosDeTarea.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id de la tarea no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve POST /api/tasks.",
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

  const entrada = actualizarTarea.safeParse(cuerpo);

  if (!entrada.success) {
    // Las claves sobrantes que tienen un endpoint propio. Comparar por
    // `issue.code` narrowea el issue, asi que `issue.keys` sale tipado y no hay
    // que castear el error de Zod.
    const aMove = entrada.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys.filter((clave) => A_MOVE.has(clave)) : [],
    );

    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
      ...(aMove.length === 0
        ? {}
        : {
            hint: `Cambiar ${aMove.join(" o ")} de una tarea es POST /api/tasks/${parametros.data.id}/move, no PATCH. Esta misma llamada sirve sin esos campos para el resto.`,
          }),
    });
  }

  /**
   * El spread condicional mantiene separados "no mandaste el campo" y "lo
   * mandaste en null", que es el punto entero de este handler y la misma regla
   * que aplica PATCH /api/boards/{id}.
   *
   * Zod omite la clave de un opcional ausente, asi que `undefined` significa
   * ausente y nada mas; el spread la deja fuera del patch y el nucleo la
   * conserva porque decide con `patch.x === undefined`. Un
   * `description: entrada.data.description` liso pondria la clave en undefined
   * en el caso ausente, las dos intenciones llegarian identicas y borrar una
   * descripcion pasaria a ser imposible de pedir. Lo defiende el TYPECHECK
   * —exactOptionalPropertyTypes— y no la suite: `TaskService.update` decide con
   * `patch.description === undefined`, igual que el de tablero, asi que la
   * version colapsada deja los tests en verde y falla con TS2375.
   *
   * `due_date` en null se pasa en null —quitar el vencimiento— y con fecha se
   * ancla a medianoche UTC con `aFechaUtc`, la misma conversion que usa el
   * create: la columna es DATE y sin anclar, el mismo cuerpo guardaria dias
   * distintos segun la zona del proceso.
   */
  const patch: UpdateTaskInput = {
    ...(entrada.data.title === undefined ? {} : { title: entrada.data.title }),
    ...(entrada.data.description === undefined ? {} : { description: entrada.data.description }),
    ...(entrada.data.priority === undefined ? {} : { priority: entrada.data.priority }),
    ...(entrada.data.due_date === undefined
      ? {}
      : { dueDate: entrada.data.due_date === null ? null : aFechaUtc(entrada.data.due_date) }),
  };

  // Un patch que no cambia nada —`{}`, o el mismo valor que ya estaba— llega
  // igual al nucleo, que lo resuelve como exito sin escribir ni auditar (5.2).
  // El borde no lo intercepta: seria una segunda definicion de "cambio
  // efectivo", libre de separarse de la del nucleo.
  //
  // TASK_NOT_FOUND (404), TITLE_REQUIRED y TITLE_TOO_LONG (400) salen de aca
  // como DomainError y los traduce el try/catch de `conAuth` con el mapeo de la
  // 6.4.
  const actualizada = await taskman.updateTask(parametros.data.id, patch, contextoDeApi(auth));

  const salida = esquemaDeTarea.safeParse(aTareaSalida(actualizada) satisfies Tarea);

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de PATCH /api/tasks/{id} no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});

/**
 * DELETE /api/tasks/{id} (6.2, RF-06). Scope delete.
 *
 * 204 SIN CUERPO, como los otros dos DELETE del capitulo 6. Lo que habria para
 * poner en un cuerpo es el orden resultante de la columna, y hoy no se puede
 * sin cambiar el nucleo: `TaskService.delete` devuelve void. Devolverlo ademas
 * mezclaria dos instantes, porque habria que leerlo DESPUES de la transaccion
 * que reindexo. Quien lo necesite tiene GET /api/tasks filtrando por columna.
 *
 * La REINDEXACION no se pide desde aca: es parte de lo que el servicio hace
 * dentro de la transaccion del borrado (5.2), que reescribe la secuencia
 * completa 0..n-1 de la columna. Un borrado que dejara un hueco seria un bug
 * del nucleo, no de este handler.
 */
export const DELETE = conAuth<[ContextoRuta]>("delete", async (_request, auth, contexto) => {
  const parametros = parametrosDeTarea.safeParse(await contexto.params);

  if (!parametros.success) {
    return respuestaDeError("VALIDATION_ERROR", "El id de la tarea no es un UUID valido.", 400, auth, {
      details: { issues: parametros.error.issues },
      hint: "Usa el id que devuelve POST /api/tasks.",
    });
  }

  // Un id que ya no existe —porque nunca existio o porque este mismo endpoint lo
  // borro antes— sale por TASK_NOT_FOUND y lo traduce a 404 el try/catch de
  // `conAuth`. No se intercepta aca para que borrar dos veces no tenga una
  // respuesta distinta de borrar algo inexistente: son el mismo estado.
  await taskman.deleteTask(parametros.data.id, contextoDeApi(auth));

  return responderSinCuerpo(auth);
});
