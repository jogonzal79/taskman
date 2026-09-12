import {
  consultaDeTareas,
  crearTarea,
  listadoDeTareas,
  tarea as esquemaDeTarea,
  type OrdenDeTarea,
  type Tarea,
} from "@taskman/contracts";
import {
  crearCorePort,
  type CreateTaskInput,
  type ListTasksQuery,
  type TaskOrderBy,
} from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../lib/http.js";
import { aFechaUtc, aTareaSalida } from "../../../lib/tareas.js";

/**
 * GET /api/tasks (6.2, 6.3.2, RF-04): lista y filtra tareas. Scope read.
 * POST /api/tasks (6.2, 6.3.1, RF-03): crea una tarea. Scope write.
 *
 * NINGUNA regla de la 5.2 se implementa aca. El titulo lo normaliza
 * `normalizarTitulo`, que la columna exista y pertenezca al tablero lo comprueban
 * `resolverColumna` y `assertColumnaDelTablero`, el "al final si no se indica
 * position" es el `input.position ?? "end"` del servicio, y el orden denso 0..n-1
 * lo sostiene `rewriteColumn`, que reescribe la secuencia COMPLETA de la columna
 * dentro de la misma transaccion que inserta. El adaptador valida la forma del
 * cuerpo, traduce y responde.
 *
 * La RESOLUCION de `column_key` tampoco vive aca, y eso importa porque es lo que
 * podria haber parecido trabajo de adaptador: `resolverColumna` la resuelve
 * dentro del tablero e implementa el "si vienen ambos gana column_id" de la
 * 6.3.1, asi que el borde MCP y el REST resuelven una referencia por key con el
 * MISMO codigo y no pueden divergir.
 */

// Una tarea recien creada no se cachea: la respuesta describe un orden que esta
// peticion acaba de cambiar.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/**
 * El vocabulario del borde al del dominio: la 6.3.2 nombra los ordenes en
 * snake_case y `TaskOrderBy` los tiene en camelCase. La tabla vive aca, igual que
 * la de los scopes en `lib/auth.ts`: el nucleo habla su vocabulario y el
 * adaptador el del protocolo.
 */
const ORDEN_DE_DOMINIO: Record<OrdenDeTarea, TaskOrderBy> = {
  position: "position",
  due_date: "dueDate",
  priority: "priority",
  created_at: "createdAt",
};

/**
 * GET /api/tasks (6.3.2). Scope read.
 *
 * NINGUN filtro se aplica aca. Los traduce a `ListTasksQuery` y los resuelve
 * `TaskRepository.listTasks` en UNA consulta: las prioridades como un `IN`, el
 * rango de fechas como dos comparaciones, y `overdue` como `due_date <
 * CURRENT_DATE` mas la exclusion de las columnas cuya key es DONE. La paginacion
 * tambien es suya y es keyset en SQL, con `id` de desempate, igual que
 * GET /api/boards: el adaptador no corta ni reordena nada en memoria.
 *
 * `column_key` la resuelve el nucleo —`TaskService.#resolverFiltro` la traduce a
 * `columnId` antes de consultar, con la misma `resolverColumna` que usa el
 * create— asi que por key y por id se filtra igual sin que el borde lo sepa.
 */
export const GET = conAuth("read", async (request, auth): Promise<Response> => {
  const parametros = new URL(request.url).searchParams;

  /**
   * `getAll` para `priority`, que la 6.3.2 declara repetible: `?priority=HIGH&
   * priority=URGENT` actua como OR. Los demas son escalares, y `?x=abc` no puede
   * caer en un default —seria devolver otra cosa a quien pidio algo concreto y no
   * enterarse nunca— asi que van al esquema tal como llegaron.
   */
  const prioridades = parametros.getAll("priority");

  const consulta = consultaDeTareas.safeParse({
    limit: parametros.get("limit") ?? undefined,
    cursor: parametros.get("cursor") ?? undefined,
    board_id: parametros.get("board_id") ?? undefined,
    column_id: parametros.get("column_id") ?? undefined,
    column_key: parametros.get("column_key") ?? undefined,
    priority: prioridades.length === 0 ? undefined : prioridades,
    due_before: parametros.get("due_before") ?? undefined,
    due_after: parametros.get("due_after") ?? undefined,
    overdue: parametros.get("overdue") ?? undefined,
    order_by: parametros.get("order_by") ?? undefined,
  });

  if (!consulta.success) {
    return respuestaDeError(
      "VALIDATION_ERROR",
      "Los parametros de la consulta no superan el esquema.",
      400,
      auth,
      { details: { issues: consulta.error.issues } },
    );
  }

  // Todo lo opcional va condicional y no como `campo: undefined`, por
  // exactOptionalPropertyTypes: la propiedad presente en undefined no es lo mismo
  // que ausente.
  const query: ListTasksQuery = {
    limit: consulta.data.limit,
    ...(consulta.data.cursor === undefined ? {} : { cursor: consulta.data.cursor }),
    ...(consulta.data.board_id === undefined ? {} : { boardId: consulta.data.board_id }),
    ...(consulta.data.column_id === undefined ? {} : { columnId: consulta.data.column_id }),
    ...(consulta.data.column_key === undefined ? {} : { columnKey: consulta.data.column_key }),
    ...(consulta.data.priority === undefined ? {} : { priority: consulta.data.priority }),
    ...(consulta.data.due_before === undefined
      ? {}
      : { dueBefore: aFechaUtc(consulta.data.due_before) }),
    ...(consulta.data.due_after === undefined
      ? {}
      : { dueAfter: aFechaUtc(consulta.data.due_after) }),
    ...(consulta.data.overdue === undefined ? {} : { overdue: consulta.data.overdue }),
    ...(consulta.data.order_by === undefined
      ? {}
      : { orderBy: ORDEN_DE_DOMINIO[consulta.data.order_by] }),
  };

  const pagina = await taskman.listTasks(query);

  const salida = listadoDeTareas.safeParse({
    items: pagina.items.map(aTareaSalida),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de GET /api/tasks no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});

export const POST = conAuth("write", async (request, auth): Promise<Response> => {
  let cuerpo: unknown;

  try {
    cuerpo = await request.json();
  } catch {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no es JSON valido.", 400, auth, {
      hint: "Envia un cuerpo JSON con 'Content-Type: application/json'.",
    });
  }

  const entrada = crearTarea.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
    });
  }

  /**
   * Los opcionales van condicionales y no como `campo: undefined`, por
   * exactOptionalPropertyTypes y porque para el nucleo ausente tiene significado
   * propio en cada uno: `position` ausente es "al final", `priority` ausente es
   * MEDIUM.
   *
   * `position: null` se traduce a AUSENTE, no a 0. La 6.3.1 documenta el null
   * como "al final de la columna", que es exactamente lo que el nucleo hace con
   * la ausencia; mandarlo como 0 lo pondria primero, o sea lo contrario de lo
   * que pidio quien llamo.
   *
   * `description` y `due_date` en null SI se pasan en null: ahi null es un valor
   * —sin descripcion, sin fecha— y no un "no me dijeron nada".
   */
  const input: CreateTaskInput = {
    boardId: entrada.data.board_id,
    title: entrada.data.title,
    ...(entrada.data.column_id === undefined ? {} : { columnId: entrada.data.column_id }),
    ...(entrada.data.column_key === undefined ? {} : { columnKey: entrada.data.column_key }),
    ...(entrada.data.description === undefined ? {} : { description: entrada.data.description }),
    ...(entrada.data.priority === undefined ? {} : { priority: entrada.data.priority }),
    ...(entrada.data.due_date === undefined
      ? {}
      : { dueDate: entrada.data.due_date === null ? null : aFechaUtc(entrada.data.due_date) }),
    ...(entrada.data.position === undefined || entrada.data.position === null
      ? {}
      : { position: entrada.data.position }),
  };

  // BOARD_NOT_FOUND (404), COLUMN_NOT_FOUND (404), COLUMN_NOT_IN_BOARD (409),
  // TITLE_REQUIRED, TITLE_TOO_LONG, COLUMN_KEY_REQUIRED, COLUMN_KEY_TOO_LONG e
  // INVALID_ORDER (400) salen de aca como DomainError y los traduce el try/catch
  // de `conAuth` con el mapeo de la 6.4.
  const creada = await taskman.createTask(input, contextoDeApi(auth));

  /**
   * DEVUELVE LA TAREA SOLA, y es la forma que escribe la 6.3.1.
   *
   * Se aparta de lo que hacen POST /api/boards/{id}/columns y PATCH
   * /api/columns/{id}, que devuelven tambien el orden resultante, y el motivo del
   * corte es que ACA la especificacion fija el cuerpo: la 6.3.1 es el unico
   * endpoint del capitulo 6 cuya respuesta esta escrita campo por campo. Donde la
   * especificacion calla, elegimos; donde escribe un ejemplo, un cliente que
   * programo contra el tiene razon y nosotros no.
   *
   * Lo que se pierde es real y conviene tenerlo anotado: insertar en una position
   * intermedia desplaza a las demas tareas de la columna, y esta respuesta no lo
   * cuenta. El `position` devuelto dice donde quedo la nueva, y la regla es total
   * —todo lo que estaba en esa position o despues corrio uno—, asi que el orden
   * nuevo es derivable; quien no quiera derivarlo tiene GET /api/tasks filtrando
   * por columna.
   */
  const salida = esquemaDeTarea.safeParse(aTareaSalida(creada) satisfies Tarea);

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de POST /api/tasks no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  // 201 y no 200: la 6.3.1 lo fija para los POST que crean un recurso.
  return responder(salida.data, 201, auth);
});
