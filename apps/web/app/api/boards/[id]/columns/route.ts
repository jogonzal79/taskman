import {
  columnaCreada,
  crearColumna,
  parametrosDeTablero,
  type Columna,
  type ColumnaCreada,
} from "@taskman/contracts";
import { crearCorePort, type Column, type CreateColumnInput } from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../../lib/auth.js";
import { respuestaDeError, respuestaDeFallo, responder } from "../../../../../lib/http.js";

/**
 * POST /api/boards/{id}/columns (6.2, RF-02): agrega una columna al tablero.
 *
 * Requiere scope write (7.2). La autenticacion, el X-Request-Id de la 6.1 y la
 * traduccion de errores de dominio a HTTP las aporta `conAuth`: este archivo no
 * arma respuestas de error a mano salvo las que ocurren ANTES de llegar al
 * nucleo, o sea el id de tablero malformado y el cuerpo que no es JSON.
 *
 * NINGUNA regla de la 5.2 se implementa aca, y eso es el punto. La key la
 * normaliza `normalizarColumnKey`, la unicidad por tablero la comprueba
 * `ColumnService.create` antes de insertar, el "al final si no se indica
 * position" es su `input.position ?? "end"`, y el orden denso 0..n-1 lo sostiene
 * `rewriteBoardColumns`, que reescribe la secuencia COMPLETA del tablero dentro
 * de la misma transaccion que inserta. El adaptador valida la forma del cuerpo,
 * invoca y traduce.
 */

// Una columna recien creada no se cachea: la respuesta describe un orden que
// esta peticion acaba de cambiar.
export const dynamic = "force-dynamic";

const taskman = crearCorePort();

/** La traduccion camelCase -> snake_case vive en el adaptador (6.1). */
function aSalida(columna: Column): Columna {
  return {
    id: columna.id,
    board_id: columna.boardId,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    created_at: columna.createdAt.toISOString(),
    updated_at: columna.updatedAt.toISOString(),
  };
}

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

export const POST = conAuth<[ContextoRuta]>("write", async (request, auth, contexto) => {
  // El `{id}` de la ruta es el del TABLERO, asi que se valida con el mismo
  // esquema que los tres endpoints de /api/boards/{id}.
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

  const entrada = crearColumna.safeParse(cuerpo);

  if (!entrada.success) {
    return respuestaDeError("VALIDATION_ERROR", "El cuerpo de la peticion no supera el esquema.", 400, auth, {
      details: { issues: entrada.error.issues },
    });
  }

  // `position` va condicional y no como `position: undefined` por
  // exactOptionalPropertyTypes, y ademas porque ausente es justamente lo que el
  // nucleo lee como "al final": pasarla presente en undefined funcionaria hoy
  // —decide con `?? "end"`— pero dejaria al borde afirmando algo que no le
  // mandaron.
  const input: CreateColumnInput = {
    boardId: parametros.data.id,
    name: entrada.data.name,
    key: entrada.data.key,
    ...(entrada.data.position === undefined ? {} : { position: entrada.data.position }),
  };

  // BOARD_NOT_FOUND, DUPLICATE_KEY, COLUMN_KEY_REQUIRED, COLUMN_KEY_TOO_LONG,
  // NAME_REQUIRED, NAME_TOO_LONG e INVALID_ORDER salen de aca como DomainError y
  // los traduce el try/catch de `conAuth` con el mapeo de la 6.4. Envolverlos
  // aca duplicaria esa decision.
  const columna = await taskman.createColumn(input, contextoDeApi(auth));

  /**
   * El tablero se RELEE despues de crear, y no es una consulta de mas: insertar
   * en una position intermedia reescribe la position de las demas columnas, asi
   * que el orden que hay que devolver solo existe despues de la transaccion.
   *
   * `getBoard` y no `getBoardWithTaskCounts`: los recuentos no entran en esta
   * respuesta (ver `columnaCreada`), y pedirlos seria pagar el GROUP BY para
   * tirarlo.
   */
  const final = await taskman.getBoard(parametros.data.id);

  /**
   * Validar la SALIDA comprueba que el adaptador siga cumpliendo el contrato que
   * publica. Si deja de cumplirlo es un bug nuestro, asi que es un 500 y no una
   * respuesta a medias: devolver el cuerpo igual convertiria un error detectado
   * en uno silencioso que rompe al cliente mas lejos.
   */
  const salida = columnaCreada.safeParse({
    column: aSalida(columna),
    columns: final.columns.map(aSalida),
  } satisfies ColumnaCreada);

  if (!salida.success) {
    console.error(
      `[taskman-web] la respuesta de POST /api/boards/{id}/columns no cumple el contrato (${auth.requestId})`,
      salida.error.issues,
    );

    return respuestaDeFallo(new Error("La salida no cumple el contrato."), auth);
  }

  // 201 y no 200: la 6.3.1 lo fija para los POST que crean un recurso.
  return responder(salida.data, 201, auth);
});
