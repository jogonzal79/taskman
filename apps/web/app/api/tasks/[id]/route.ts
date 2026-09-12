import { parametrosDeTarea, tarea as esquemaDeTarea, type Tarea } from "@taskman/contracts";
import { crearCorePort } from "@taskman/core";

import { conAuth } from "../../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../../lib/http.js";
import { aTareaSalida } from "../../../../lib/tareas.js";

/**
 * GET /api/tasks/{id} (6.2): consulta una tarea. Scope read.
 *
 * No recibe `ActorContext` y no es un olvido: la 7.4 no audita las lecturas, y
 * `contextoDeApi` existe solo para las escrituras. Es la misma asimetria que
 * tienen los servicios y el puerto.
 */

// Una tarea cacheada responde por el estado de otro momento.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

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
