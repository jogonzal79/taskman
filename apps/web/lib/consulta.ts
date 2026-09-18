import type { z } from "zod";

import { respuestaDeError, type ContextoPeticion } from "./http";

/**
 * EL UNICO punto por donde se leen los parametros de consulta de un endpoint.
 *
 * Existe por lo mismo que `leerCuerpo`: los cinco handlers que leen parametros
 * de consulta —cuatro listados y el DELETE de columnas— armaban cada uno el
 * objeto a validar leyendo SOLO los parametros que conocen, uno por uno, asi
 * que el `strictObject` del contrato nunca veia el parametro de mas.
 * DECLARABA que los desconocidos se rechazan y el borde no lo honraba. Lo
 * peligroso no era el 200 sino creer que el parametro acoto cuando quedo
 * INERTE: `?column_key=TODO` en la busqueda devolvia el tablero entero y quien
 * lo mando no se enteraba.
 *
 * El arreglo no es agregar una comprobacion a cada handler —serian cinco sitios
 * donde ponerla, o cuatro donde olvidarla— sino que la unica forma de leer la
 * consulta entregue TODO lo que llego. El `strictObject` que ya estaba escrito
 * hace el resto.
 */

export type ConsultaLeida<T> =
  | { readonly ok: true; readonly datos: T }
  | { readonly ok: false; readonly respuesta: Response };

export interface OpcionesDeConsulta {
  /**
   * Los parametros que la 6.3.2 declara REPETIBLES, que hoy es solo `priority`:
   * `?priority=HIGH&priority=URGENT` actua como OR y el contrato los espera como
   * array. Van siempre como array, aunque llegue uno solo.
   *
   * La lista se declara en el handler y no se deduce del esquema: deducirla
   * exigiria mirar el interior de zod. Que se desincronice con el contrato no
   * devuelve otro silencio —que es lo que este modulo viene a cerrar— sino un
   * 400: un repetible que falte aca llega como texto a un `z.array(...)` y no
   * pasa.
   */
  readonly repetibles?: readonly string[];
  /** El mensaje del 400 cuando falla el esquema. Los desconocidos traen el suyo. */
  readonly mensaje?: string;
  readonly hint?: string;
}

const MENSAJE_POR_DEFECTO = "Los parametros de la consulta no superan el esquema.";

/**
 * Lee la consulta, la valida contra el esquema del contrato y, si no pasa,
 * devuelve el 400 de la 6.4 ya armado.
 *
 * Devuelve la respuesta en vez de lanzar por lo mismo que `leerCuerpo`: el
 * handler decide cuando cortar, y el error de un parametro no es un fallo de
 * dominio que `respuestaDeFallo` sepa traducir.
 */
export function leerConsulta<T>(
  request: Request,
  esquema: z.ZodType<T>,
  ctx: ContextoPeticion,
  opciones: OpcionesDeConsulta = {},
): ConsultaLeida<T> {
  const parametros = new URL(request.url).searchParams;
  const consulta = esquema.safeParse(objetoDeConsulta(parametros, opciones.repetibles ?? []));

  if (consulta.success) {
    return { ok: true, datos: consulta.data };
  }

  const issues = consulta.error.issues;

  /**
   * Los desconocidos tienen su propio mensaje y NO el del llamador: un
   * `?foo=1` en DELETE /api/columns/{id} contestado con "El parametro
   * reassign_to no es un UUID valido" manda a corregir el parametro equivocado.
   *
   * El nombre del que sobra viaja dos veces y a proposito: en el mensaje, para
   * quien lee la respuesta, y en `details.issues[].keys`, que es donde lo busca
   * un cliente que quiera actuar sobre el sin parsear una frase.
   */
  const sobrantes = [
    ...new Set(
      issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : [])),
    ),
  ];

  const mensaje =
    sobrantes.length === 0
      ? (opciones.mensaje ?? MENSAJE_POR_DEFECTO)
      : `Parametros de consulta no reconocidos: ${sobrantes.map((clave) => `'${clave}'`).join(", ")}.`;

  const hint =
    sobrantes.length === 0
      ? opciones.hint
      : "Quita el parametro o corregi su nombre: este endpoint no lo aplica, asi que aceptarlo seria acotar menos de lo que pediste.";

  return {
    ok: false,
    respuesta: respuestaDeError("VALIDATION_ERROR", mensaje, 400, ctx, {
      details: { issues },
      // Condicional por exactOptionalPropertyTypes: presente en undefined no es
      // lo mismo que ausente, y ademas se serializaria como una clave de mas.
      ...(hint === undefined ? {} : { hint }),
    }),
  };
}

/**
 * El query string como objeto plano, SIN filtrar por lo que el esquema conoce:
 * eso es justamente lo que el `strictObject` tiene que poder ver.
 *
 * PROTOTIPO NULO, y no es ceremonia: sobre un objeto literal, `?__proto__=x`
 * entra por el setter de `__proto__` y no crea ninguna propiedad propia, asi que
 * el parametro DESAPARECE antes de llegar al esquema —el mismo silencio que este
 * modulo viene a cerrar, y el unico nombre con el que sobreviviria—. Medido:
 * con literal, `Object.keys` devuelve `["constructor", "limit"]`; con prototipo
 * nulo, `["__proto__", "constructor", "limit"]`, y zod acepta los dos igual.
 *
 * UN PARAMETRO ESCALAR REPETIDO va como ARRAY y no como su primer valor, que es
 * lo que hacia `get()`. No es el parametro desconocido, pero es el mismo
 * silencio y cae del mismo lado: `?limit=10&limit=20` descartaba el 20 sin
 * decirlo. Como
 * array no pasa el esquema —`z.coerce.number()` sobre un array da NaN— y sale el
 * mismo 400 que nombra el parametro. Lo unico que se colapsa a texto es el
 * valor unico de un parametro que no se declaro repetible.
 */
function objetoDeConsulta(
  parametros: URLSearchParams,
  repetibles: readonly string[],
): Record<string, string | readonly string[]> {
  const objeto = Object.create(null) as Record<string, string | readonly string[]>;

  for (const clave of new Set(parametros.keys())) {
    const valores = parametros.getAll(clave);
    const [primero, ...resto] = valores;

    objeto[clave] =
      primero !== undefined && resto.length === 0 && !repetibles.includes(clave)
        ? primero
        : valores;
  }

  return objeto;
}
