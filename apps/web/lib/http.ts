import { randomUUID } from "node:crypto";

import { ESTADO_POR_CODIGO, type CodigoDeError, type ErrorDeApi } from "@taskman/contracts";
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
 * cuando se indexa, pero aca no se indexa: el log de la 11.1 escribe el
 * request_id como campo y la auditoria lo guarda en su columna, y en los dos se
 * busca por igualdad. No valia traer una dependencia para eso. Si mas adelante conviene ordenar por el, se cambia aca y en un solo
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
 * El mapeo de la 6.4, codigo de dominio -> HTTP. NO es una tabla: es la de
 * `packages/contracts`, anotada.
 *
 * La anotacion `Record<DomainErrorCode, number>` es lo que hace el trabajo, y es
 * a proposito que este en el tipo y no en un `??` al final: agregar un codigo a
 * `DomainErrorCode` sin estado en `ESTADO_POR_CODIGO` NO COMPILA. Un `?? 500` lo
 * dejaria caer en un 500 silencioso, que es el fallo que no se descubre hasta que
 * un cliente reporta que algo "no anda" y en el log hay un error interno que en
 * realidad era un 404.
 *
 * Y es aca y no en contracts porque este es el UNICO modulo que ve las dos cosas:
 * contracts es una hoja del grafo (3.3) y no puede importar `DomainErrorCode`, asi
 * que no puede declararse exhaustivo sobre el. La tabla vive alla —donde tambien
 * esta la envoltura, y de donde sale openapi.json— y la comprobacion vive aca. El
 * razonamiento de cada codigo que la 6.4 no nombra se fue con la tabla.
 *
 * Que `ESTADO_POR_CODIGO` tenga ADEMAS claves que no son de dominio
 * —UNAUTHENTICATED, RATE_LIMITED, INTERNAL_ERROR— no molesta: asignar una
 * variable, y no un literal, no dispara la comprobacion de propiedades en exceso.
 */
const HTTP_POR_CODIGO: Record<DomainErrorCode, number> = ESTADO_POR_CODIGO;

/**
 * La envoltura de la 6.4, derivada del esquema Zod de `packages/contracts` por
 * inferencia. Era una interfaz escrita aca, o sea una segunda definicion de la
 * misma forma que nada mantenia igual: renombrar un campo en el esquema —lo que
 * openapi.json publica— no rompia nada de este lado. Ahora si.
 */
type CuerpoError = ErrorDeApi;

function cuerpoDeError(
  code: CodigoDeError,
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
  code: CodigoDeError,
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
 * El tope de la 7.3: "Los cuerpos de peticion se limitan a 256 KB". En BYTES, que
 * es la unidad en la que la 7.3 lo escribe y la unica que se puede contar sin
 * decodificar.
 */
export const LIMITE_CUERPO_BYTES = 256 * 1024;

export type CuerpoLeido =
  | { readonly ok: true; readonly valor: unknown }
  | { readonly ok: false; readonly respuesta: Response };

/**
 * EL UNICO punto por donde se lee un cuerpo de peticion (7.3).
 *
 * Los siete handlers que reciben cuerpo hacian cada uno su `await request.json()`
 * con su try/catch: siete sitios donde poner el tope, o seis donde olvidarlo. Aca
 * el tope es la unica forma de leer.
 *
 * SE CORTA EL STREAM, no se mira la cabecera. `Content-Length` se consulta como
 * atajo —si YA declara mas que el tope, no se lee ni un byte— pero la autoridad es
 * el contador del bucle: un cuerpo troceado no lleva `Content-Length`, y uno que
 * lo lleva puede mentir. Confiar en la cabecera es confiar en el cliente, que es
 * exactamente de quien la 7.3 protege. En cuanto la cuenta pasa el tope se
 * `cancel()`ea el lector y no se lee mas: lo que queda en memoria son los trozos
 * leidos hasta ese punto, nunca los 50 MB, y `JSON.parse` no se llega a llamar.
 *
 * Devuelve la respuesta armada en vez de lanzar porque el llamador la necesita
 * ANTES de resolver la idempotencia de la 6.5, que ocurre antes del esquema.
 */
export async function leerCuerpo(
  request: Request,
  ctx: ContextoPeticion,
): Promise<CuerpoLeido> {
  const declarado = Number(request.headers.get("content-length") ?? "");

  if (Number.isFinite(declarado) && declarado > LIMITE_CUERPO_BYTES) {
    return { ok: false, respuesta: demasiadoGrande(declarado, ctx) };
  }

  const texto = await leerTextoAcotado(request);

  if (texto === undefined) {
    return { ok: false, respuesta: demasiadoGrande(undefined, ctx) };
  }

  try {
    return { ok: true, valor: JSON.parse(texto) };
  } catch {
    // Todavia no hay esquema que aplicar: el cuerpo ni siquiera es JSON. Es un
    // 400 igual, y con el mismo codigo, porque para quien llama el problema es el
    // mismo —lo que mando no sirve— y la 6.4 no tiene otro para esto.
    return {
      ok: false,
      respuesta: respuestaDeError(
        "VALIDATION_ERROR",
        "El cuerpo de la peticion no es JSON valido.",
        400,
        ctx,
        { hint: "Envia un cuerpo JSON con 'Content-Type: application/json'." },
      ),
    };
  }
}

/**
 * Lee el cuerpo trozo a trozo y devuelve `undefined` en cuanto pasa el tope.
 *
 * El contador va sobre `byteLength` y no sobre la longitud del texto: los bytes
 * son lo que ocupa la peticion, y decodificar para medir seria decodificar lo que
 * se va a descartar. La decodificacion ocurre una sola vez, al final, sobre como
 * mucho 256 KB mas un trozo.
 */
async function leerTextoAcotado(request: Request): Promise<string | undefined> {
  if (request.body === null) {
    return "";
  }

  const lector = request.body.getReader();
  const trozos: Uint8Array[] = [];
  let leidos = 0;

  try {
    for (;;) {
      const { done, value } = await lector.read();

      if (done) {
        break;
      }

      leidos += value.byteLength;

      if (leidos > LIMITE_CUERPO_BYTES) {
        // Se corta la fuente: el resto del cuerpo no se transfiere ni se guarda.
        await lector.cancel();

        return undefined;
      }

      trozos.push(value);
    }
  } finally {
    lector.releaseLock();
  }

  const completo = new Uint8Array(leidos);
  let escrito = 0;

  for (const trozo of trozos) {
    completo.set(trozo, escrito);
    escrito += trozo.byteLength;
  }

  return new TextDecoder().decode(completo);
}

/**
 * El 413 de la 7.3. `details` lleva el tope y, si la peticion lo declaro, cuanto
 * declaro: un cliente que reintenta necesita saber contra que numero recortar.
 */
function demasiadoGrande(declarado: number | undefined, ctx: ContextoPeticion): Response {
  return respuestaDeError(
    "PAYLOAD_TOO_LARGE",
    `El cuerpo de la peticion supera el limite de ${LIMITE_CUERPO_BYTES} bytes.`,
    413,
    ctx,
    {
      details: {
        limit_bytes: LIMITE_CUERPO_BYTES,
        ...(declarado === undefined ? {} : { declared_bytes: declarado }),
      },
      hint: "Divide la operacion en varias peticiones mas chicas.",
    },
  );
}

/**
 * Traduce cualquier fallo de un handler a una respuesta de la 6.4.
 *
 * Lo que no es un `DomainError` es un fallo no controlado: 500 con un mensaje
 * que no dice nada del interior y la traza completa al log de la 11.1. El nucleo ya distingue
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
