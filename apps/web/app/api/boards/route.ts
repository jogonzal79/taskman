import {
  consultaDeListado,
  crearTablero,
  listadoDeTableros,
  tableroDetallado,
  type ColumnaDetallada,
  type Tablero,
  type TableroDetallado,
} from "@taskman/contracts";
import {
  crearCorePort,
  type Board,
  type BoardDetail,
  type Column,
  type CreateBoardInput,
  type ListBoardsQuery,
} from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../lib/http.js";

/**
 * GET /api/boards (6.2): lista tableros, paginado por cursor.
 * POST /api/boards (6.2, RF-01): crea un tablero con sus columnas por defecto.
 *
 * Requieren una API key con scope read y write respectivamente (7.2). La
 * verificacion la aporta `conAuth`, que recibe el scope como argumento
 * obligatorio: montar cualquiera de los dos sin declararlo no compila.
 *
 * El adaptador no ve Prisma (3.2): habla con el nucleo por `TaskManagerPort` y
 * su unica responsabilidad es validar la entrada, invocar el servicio y
 * traducir el resultado al protocolo.
 */

// Un listado cacheado devuelve los tableros de otro momento.
export const dynamic = "force-dynamic";

/**
 * A nivel de modulo a proposito. `crearCorePort` solo arma servicios y
 * repositorios; el cliente Prisma que le pasa por dentro es el proxy perezoso,
 * asi que construir esto no toca la base ni exige DATABASE_URL. De eso depende
 * que `next build` pueda importar esta ruta para inspeccionarla.
 */
const taskman = crearCorePort();

/** La traduccion camelCase -> snake_case vive en el adaptador (6.1). */
function aSalida(board: Board): Tablero {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    created_at: board.createdAt.toISOString(),
    updated_at: board.updatedAt.toISOString(),
  };
}


export const GET = conAuth("read", async (request, auth): Promise<Response> => {
  const parametros = new URL(request.url).searchParams;

  // `?limit=abc` no puede caer en el default: seria devolver 50 tableros a
  // alguien que pidio otra cosa y no enterarse nunca.
  const consulta = consultaDeListado.safeParse({
    limit: parametros.get("limit") ?? undefined,
    cursor: parametros.get("cursor") ?? undefined,
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

  // `cursor` va condicional y no como `cursor: undefined` por
  // exactOptionalPropertyTypes: la propiedad presente en undefined no es lo
  // mismo que ausente.
  const query: ListBoardsQuery = {
    limit: consulta.data.limit,
    ...(consulta.data.cursor === undefined ? {} : { cursor: consulta.data.cursor }),
  };

  const pagina = await taskman.listBoards(query);

  /**
   * Validar la SALIDA no es paranoia sobre datos ajenos: lo que se comprueba es
   * que el adaptador siga cumpliendo el contrato que publica. Si deja de
   * cumplirlo es un bug nuestro, asi que es un 500 y no una respuesta a medias:
   * devolver el cuerpo igual convertiria un error detectado en uno silencioso
   * que rompe al cliente mas lejos.
   */
  const salida = listadoDeTableros.safeParse({
    items: pagina.items.map(aSalida),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    console.error("[taskman-web] la respuesta de GET /api/boards no cumple el contrato", salida.error.issues);

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  return responder(salida.data, 200, auth);
});

/**
 * Las columnas recien creadas, con su recuento en cero.
 *
 * El cero no se consulta ni se adivina: `BoardService.create` devuelve el
 * tablero y sus columnas creados en UNA transaccion, y nadie pudo insertar una
 * tarea en una columna cuyo id se esta viendo por primera vez en esta
 * respuesta. Pedirle el recuento a la base seria una consulta para confirmar lo
 * que la transaccion que acaba de commitear ya garantiza.
 */
function aColumnaNuevaSalida(columna: Column): ColumnaDetallada {
  return {
    id: columna.id,
    board_id: columna.boardId,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    task_count: 0,
    created_at: columna.createdAt.toISOString(),
    updated_at: columna.updatedAt.toISOString(),
  };
}

function aDetalleSalida(board: BoardDetail): TableroDetallado {
  return {
    ...aSalida(board),
    columns: board.columns.map(aColumnaNuevaSalida),
    task_count: 0,
  };
}

/**
 * POST /api/boards (6.2, RF-01). Scope write.
 *
 * Devuelve 201 y no 200, como fija la 6.3.1 para los POST que crean, y el
 * tablero CON sus columnas. Lo segundo es una decision: la 6.2 no dice que
 * devuelve un POST, pero las cuatro columnas de la 4.3 son justamente lo que
 * este endpoint crea ademas del tablero, y son las que hacen falta para la
 * llamada siguiente, que casi siempre es crear una tarea. Omitirlas obligaria a
 * un GET /api/boards/{id} inmediato para leer ids y keys que el nucleo ya
 * devolvio: el mismo argumento con el que la 6.3.1 justifica `column_key`.
 *
 * Las columnas NO se crean aca. Las crea `BoardService.create` en la misma
 * transaccion que el tablero (4.3), que es donde tienen que estar: un tablero
 * sin columnas no es un estado util, y armarlas en el adaptador dejaria dos
 * definiciones de las cuatro por defecto —esta y la del borde MCP— libres de
 * separarse.
 */
export const POST = conAuth("write", async (request, auth): Promise<Response> => {
  let cuerpo: unknown;

  try {
    cuerpo = await request.json();
  } catch {
    // Todavia no hay esquema que aplicar: el cuerpo ni siquiera es JSON. Es un
    // 400 igual, y con el mismo codigo, porque para quien llama el problema es
    // el mismo —lo que mando no sirve— y la 6.4 no tiene otro para esto.
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no es JSON valido.", 400, auth, {
      hint: "Envia un cuerpo JSON con 'Content-Type: application/json'.",
    });
  }

  const entrada = crearTablero.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
    });
  }

  // `description` va condicional y no como `description: undefined` por
  // exactOptionalPropertyTypes: la propiedad presente en undefined no es lo
  // mismo que ausente.
  const input: CreateBoardInput = {
    name: entrada.data.name,
    ...(entrada.data.description === undefined ? {} : { description: entrada.data.description }),
  };

  // Primera escritura del borde REST, y por eso la primera que lleva
  // `ActorContext` (7.4). El requestId que va adentro es el mismo que viaja en
  // la cabecera X-Request-Id de esta respuesta, que es lo que permite ir del
  // registro de auditoria a la peticion que lo produjo.
  const tablero = await taskman.createBoard(input, contextoDeApi(auth));

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato que
   * publica. Si deja de cumplirlo es un bug nuestro, asi que es un 500 y no una
   * respuesta a medias: devolver el cuerpo igual convertiria un error detectado
   * en uno silencioso que rompe al cliente mas lejos.
   */
  const salida = tableroDetallado.safeParse(aDetalleSalida(tablero));

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de POST /api/boards no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  // 201 y no 200: la 6.3.1 lo fija para los POST que crean un recurso.
  return responder(salida.data, 201, auth);
});
