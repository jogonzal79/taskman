import { randomUUID } from "node:crypto";

import { isDomainError, type DomainErrorCode } from "@taskman/core";

import { registrarFallo } from "./log.js";

/**
 * Envoltura de respuestas y modelo de errores del borde HTTP (6.1 y 6.4).
 *
 * El handler no arma errores a mano: lanza (o deja pasar) un `DomainError` y
 * este modulo decide el HTTP y el cuerpo. De eso depende que dos endpoints no
 * traduzcan el mismo codigo de dominio a dos respuestas distintas.
 */

/**
 * 6.1: toda respuesta lleva X-Request-Id, y el mismo valor va en el
 * `request_id` del cuerpo de error. Se genera uno por peticion.
 *
 * El prefijo imita el `req_...` de los ejemplos de la 6.4. El identificador es
 * un UUID v4 sin guiones y no un ULID: un ULID ordena por tiempo, que es util
 * cuando se indexa, pero aca todavia no se indexa nada —el log estructurado y
 * la auditoria REST no estan cableados— y no valia traer una dependencia para
 * eso. Si mas adelante conviene ordenar por el, se cambia aca y en un solo
 * lugar.
 */
export function nuevoRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

/** Lo que todo handler necesita saber de la peticion en curso. */
export interface ContextoPeticion {
  requestId: string;
}

/**
 * Respuesta JSON con las cabeceras que fija la 6.1. `Cache-Control: no-store`
 * va en todas: un listado o un tablero cacheados responden por el estado de
 * otro momento.
 */
export function responder(
  cuerpo: unknown,
  status: number,
  ctx: ContextoPeticion,
  extra: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(cuerpo, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": ctx.requestId,
      ...extra,
    },
  });
}

/**
 * Respuesta con un cuerpo JSON YA SERIALIZADO, y con cabeceras extra.
 *
 * Existe por la 6.5: una respuesta que se va a guardar para devolverla otra vez
 * mas tarde tiene que poder reconstruirse byte a byte, y `responder` no sirve
 * para eso porque el cuerpo pasa dos veces por formas distintas —se guarda como
 * JSONB, que NO conserva el orden de las claves ni los espacios, y al leerlo de
 * vuelta `JSON.stringify` produciria otro texto—. Quien la usa serializa con
 * `canonicalizar` en los dos lados y obtiene el mismo texto en los dos.
 *
 * Las cabeceras son las de `responder` mas las que pase el llamador, que hoy
 * son solo la `Idempotency-Replayed` de la 6.5.
 */
export function responderTexto(
  cuerpo: string,
  status: number,
  ctx: ContextoPeticion,
  extra: Readonly<Record<string, string>> = {},
): Response {
  return new Response(cuerpo, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Request-Id": ctx.requestId,
      ...extra,
    },
  });
}

/**
 * Respuesta SIN cuerpo, para el 204 de un DELETE.
 *
 * No se puede resolver con `responder(null, 204, ctx)`: 204 es uno de los
 * estados que la especificacion de fetch declara sin cuerpo, y construir una
 * Response con cuerpo y ese estado lanza. `Response.json` siempre escribe uno,
 * aunque sea el literal `null`.
 *
 * Las cabeceras son las mismas que las de `responder`, y el X-Request-Id
 * importa especialmente aca: es lo unico que devuelve un 204, y sin el no habria
 * con que correlacionar un borrado con su registro de auditoria (6.1).
 */
export function responderSinCuerpo(ctx: ContextoPeticion): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": ctx.requestId,
    },
  });
}

/**
 * El mapeo de la 6.4, codigo de dominio -> HTTP.
 *
 * Es un `Record<DomainErrorCode, number>` A PROPOSITO, y no un objeto suelto
 * con un `?? 500` al final: asi, agregar un codigo a `DomainErrorCode` sin
 * mapearlo aca NO compila. Un `??` lo dejaria caer en un 500 silencioso, que es
 * exactamente el fallo que no se descubre hasta que un cliente reporta que algo
 * "no anda" y en el log hay un error interno que en realidad era un 404.
 *
 * Los codigos que la 6.4 no nombra estan igual, con su HTTP razonado abajo: la
 * tabla de la especificacion se escribio antes que varios de ellos.
 */
const HTTP_POR_CODIGO: Record<DomainErrorCode, number> = {
  // --- En la tabla de la 6.4, tal cual ---------------------------------------
  VALIDATION_ERROR: 400,
  BOARD_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  COLUMN_NOT_IN_BOARD: 409,
  AMBIGUOUS_MATCH: 409,
  COLUMN_NOT_EMPTY: 409,
  DUPLICATE_KEY: 409,
  IDEMPOTENCY_MISMATCH: 422,
  CONFIRMATION_REQUIRED: 428,

  // --- No estan en la 6.4: el razonamiento de cada uno -----------------------

  // Los siete de abajo son entradas que no superan una regla de forma. La 6.4
  // les daria VALIDATION_ERROR y 400; conservan su codigo propio porque el
  // nucleo los distingue a proposito (ver domain/errors.ts: un agente tiene que
  // poder saber si le falto contenido o si le sobro), pero el HTTP es el mismo.
  TITLE_REQUIRED: 400,
  TITLE_TOO_LONG: 400,
  NAME_REQUIRED: 400,
  NAME_TOO_LONG: 400,
  DESCRIPTION_TOO_LONG: 400,
  COLUMN_KEY_REQUIRED: 400,
  COLUMN_KEY_TOO_LONG: 400,

  // Una posicion que no es un entero >= 0. Es la forma del dato, no el estado
  // del tablero: 400 y no 409.
  INVALID_ORDER: 400,

  // reassignTo apuntando a la columna que se esta borrando. A diferencia del
  // anterior, el valor es sintacticamente valido y lo que falla es su relacion
  // con el recurso: mismo caso que COLUMN_NOT_IN_BOARD, que la 6.4 pone en 409.
  INVALID_REASSIGN_TARGET: 409,

  // MCP_DESTRUCTIVE_POLICY=deny: el servidor no borra, se pida como se pida.
  // No lo puede producir REST hoy —es del borde MCP— pero el Record obliga a
  // decidirlo igual, que es justamente la gracia. 403 y no 405: el metodo
  // existe, lo que falta es permiso.
  DESTRUCTIVE_POLICY_DENIED: 403,
};

interface CuerpoError {
  error: {
    code: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
    hint?: string;
    request_id: string;
  };
}

function cuerpoDeError(
  code: string,
  message: string,
  ctx: ContextoPeticion,
  extra: { details?: Readonly<Record<string, unknown>>; hint?: string } = {},
): CuerpoError {
  // Las opcionales se agregan solo si existen, por exactOptionalPropertyTypes:
  // la propiedad presente en undefined no es lo mismo que ausente, y ademas
  // `details: undefined` se serializaria como una clave que no deberia estar.
  return {
    error: {
      code,
      message,
      ...(extra.details === undefined ? {} : { details: extra.details }),
      ...(extra.hint === undefined ? {} : { hint: extra.hint }),
      request_id: ctx.requestId,
    },
  };
}

/**
 * Error con la envoltura de la 6.4, para los codigos que no son de dominio.
 *
 * `cabeceras` existe por el 429 de la 7.3, que ademas del cuerpo tiene que
 * llevar `Retry-After`: es la unica respuesta de error del borde que dice algo
 * en una cabecera. Va aca y no en el llamador para que el 429 siga saliendo por
 * el mismo camino que los demas errores y no se arme a mano.
 */
export function respuestaDeError(
  code: string,
  message: string,
  status: number,
  ctx: ContextoPeticion,
  extra: {
    details?: Readonly<Record<string, unknown>>;
    hint?: string;
    cabeceras?: Readonly<Record<string, string>>;
  } = {},
): Response {
  return responder(cuerpoDeError(code, message, ctx, extra), status, ctx, extra.cabeceras ?? {});
}

/**
 * Traduce cualquier fallo de un handler a una respuesta de la 6.4.
 *
 * Lo que no es un `DomainError` es un fallo no controlado: 500 con un mensaje
 * que no dice nada del interior y el detalle al stderr. El nucleo ya distingue
 * lo que es error de negocio de lo que no, asi que esa frontera no se vuelve a
 * decidir aca.
 */
export function respuestaDeFallo(error: unknown, ctx: ContextoPeticion): Response {
  if (isDomainError(error)) {
    return respuestaDeError(error.code, error.message, HTTP_POR_CODIGO[error.code], ctx, {
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }

  // Las dos mitades de la 11.1: la traza COMPLETA al log y al cliente solo el
  // codigo y el request_id, que es lo que permite correlacionar uno con otro sin
  // contarle nada del interior a quien llamo.
  registrarFallo(ctx.requestId, error);

  return respuestaDeError("INTERNAL_ERROR", "Fallo no controlado.", 500, ctx);
}
