import { createHash } from "node:crypto";

import { DomainError, type IdempotencyRecord } from "@taskman/core";

import type { Autenticacion } from "./auth";
import { responderTexto, type ContextoPeticion } from "./http";

/**
 * La idempotencia de la 6.5, del lado del borde HTTP.
 *
 * Reparto de responsabilidades (3.2): aca se decide QUE identifica a una
 * peticion —la canonicalizacion del cuerpo y su SHA-256— y que hacer con cada
 * uno de los tres casos; el nucleo solo guarda la fila y la devuelve. El nucleo
 * nunca ve una cabecera y este modulo nunca ve Prisma.
 */

export const CABECERA_CLAVE = "Idempotency-Key";

/**
 * La 6.5 la nombra solo para el caso reproducido. Va tambien en la respuesta de
 * la PRIMERA ejecucion, con "false", y es una decision: sin ella, un cliente que
 * mando la cabecera no puede distinguir "se ejecuto ahora" de "este servidor
 * ignora la idempotencia", que son dos cosas muy distintas para quien reintenta
 * tras un timeout. Las tres respuestas posibles quedan separadas: ausente (no
 * mando clave), "false" (se ejecuto), "true" (se reprodujo).
 */
export const CABECERA_REPLAY = "Idempotency-Replayed";

/** El VARCHAR(128) de `idempotency_record.key`. */
export const LIMITE_CLAVE_IDEMPOTENCIA = 128;

/**
 * Serializacion CANONICA: la forma unica de un valor JSON.
 *
 * Las reglas, y por que cada una:
 *
 *   - Las claves de un objeto salen ORDENADAS, y recursivamente. Dos clientes
 *     que mandan los mismos campos en distinto orden mandaron la misma peticion:
 *     el orden de las claves de un objeto JSON no significa nada, asi que tomarlo
 *     por distinto convertiria un reintento legitimo en un 422.
 *   - Los arrays NO se ordenan. Ahi el orden SI significa, y es justo el caso
 *     donde equivocarse es peligroso: reordenar las columnas de un tablero
 *     produciria otro tablero, asi que dos cuerpos que solo difieren en el orden
 *     de un array son dos peticiones distintas.
 *   - El orden es el de las UNIDADES DE CODIGO UTF-16, o sea el de `<` sobre
 *     cadenas, y NO `localeCompare`: una comparacion sensible al locale daria
 *     ordenes distintos en dos maquinas y el mismo cuerpo hashearia distinto
 *     segun donde corra el servidor.
 *   - El unicode NO se normaliza. "é" precompuesta y "é" descompuesta son dos
 *     cadenas distintas y se hashean distinto. Normalizar seria decidir por el
 *     cliente que dos textos que el mando distintos son el mismo, y esto tiene
 *     que decir si la peticion es LA MISMA, no si se parece.
 *
 * Se usa para las DOS cosas que tienen que ser reproducibles, y a proposito es
 * una sola funcion: el hash de la peticion y el texto de la respuesta que se
 * guarda. Ver `responderTexto`.
 */
export function canonicalizar(valor: unknown): string {
  if (valor === null || typeof valor !== "object") {
    // `JSON.stringify(undefined)` devuelve undefined, no una cadena. No puede
    // llegar desde `request.json()` ni desde JSONB, pero el tipo es `unknown`.
    return JSON.stringify(valor) ?? "null";
  }

  if (Array.isArray(valor)) {
    return `[${valor.map(canonicalizar).join(",")}]`;
  }

  const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return `{${entradas.map(([clave, v]) => `${JSON.stringify(clave)}:${canonicalizar(v)}`).join(",")}}`;
}

/**
 * El SHA-256 que identifica la peticion (6.5).
 *
 * ENTRAN EL METODO Y LA RUTA ademas del cuerpo. Sin ellos, la misma clave con el
 * mismo cuerpo en dos endpoints distintos —y `{"name":"X"}` es un cuerpo valido
 * en mas de uno— coincidiria, y el segundo se llevaria de vuelta la respuesta
 * del primero. Van dentro del mismo array canonicalizado y no concatenados con
 * un separador: en JSON cada elemento esta delimitado, asi que ninguna ruta que
 * contenga el separador puede hacerse pasar por otra cosa.
 *
 * La ruta es el PATHNAME, no la URL entera: el host cambia con el proxy y con el
 * entorno, y la misma peticion no puede hashear distinto segun por donde entro.
 * La query tampoco entra, porque ningun POST la lee.
 *
 * SE HASHEA EL CUERPO CRUDO YA PARSEADO, no el que devuelve Zod. El validado
 * recorta espacios y descarta campos, asi que dos cuerpos distintos pueden
 * validar al mismo, y entonces reusar una clave con un cuerpo que el cliente
 * escribio distinto pasaria por reintento. Al reves —hashear el crudo— lo que se
 * pierde es que `{"name":"X "}` y `{"name":"X"}` cuenten como la misma peticion,
 * que es el error seguro de los dos: devuelve 422 y no una respuesta ajena.
 */
export function hashDePeticion(metodo: string, ruta: string, cuerpo: unknown): string {
  return createHash("sha256").update(canonicalizar([metodo, ruta, cuerpo]), "utf8").digest("hex");
}

/** Los tres campos que identifican la fila que se guardara si se ejecuta. */
export interface ClaveDeIdempotencia {
  key: string;
  clientId: string;
  requestHash: string;
}

/**
 * Los tres caminos de la 6.5, resueltos antes de tocar el nucleo.
 *
 * `reproducir` ya trae la respuesta armada; `ejecutar` trae lo que hay que
 * guardar cuando la operacion termine. El cuarto caso de la 6.5 —el hash
 * distinto— no esta en la union porque no es un camino sino un error: sale por
 * `IDEMPOTENCY_MISMATCH`.
 */
export type Idempotencia =
  | { tipo: "sin-clave" }
  | { tipo: "reproducir"; respuesta: Response }
  | { tipo: "ejecutar"; clave: ClaveDeIdempotencia };

export type BuscarRegistro = (
  key: string,
  clientId: string,
) => Promise<IdempotencyRecord | undefined>;

/**
 * Lee la cabecera. Ausente devuelve undefined; presente pero inservible es un
 * 400 y no un "como si no viniera": alguien que manda `Idempotency-Key` esta
 * pidiendo la garantia, y tratarla como ausente le daria un 201 que parece
 * exitoso mientras la garantia que pidio no se aplico.
 *
 * El tope se comprueba en PUNTOS DE CODIGO, que es lo que mide el VARCHAR(128)
 * de PostgreSQL, y no en unidades UTF-16 como `.length`. Sin esta comprobacion,
 * una clave larga saldria como un 22001 del driver, o sea un 500 por una entrada
 * del cliente.
 */
export function leerClaveIdempotencia(request: Request): string | undefined {
  const valor = request.headers.get(CABECERA_CLAVE);

  if (valor === null) {
    return undefined;
  }

  // `Headers` ya recorta los blancos de los extremos por la especificacion de
  // HTTP; lo que puede quedar es una cabecera enviada vacia.
  if (valor === "") {
    throw new DomainError("VALIDATION_ERROR", `La cabecera ${CABECERA_CLAVE} esta vacia.`, {
      details: { header: CABECERA_CLAVE },
      hint: "Envia un valor unico por peticion, o no envies la cabecera.",
    });
  }

  const caracteres = [...valor].length;
  if (caracteres > LIMITE_CLAVE_IDEMPOTENCIA) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `La cabecera ${CABECERA_CLAVE} tiene ${caracteres} caracteres y el maximo es ${LIMITE_CLAVE_IDEMPOTENCIA}.`,
      {
        details: {
          header: CABECERA_CLAVE,
          length: caracteres,
          maxLength: LIMITE_CLAVE_IDEMPOTENCIA,
        },
      },
    );
  }

  return valor;
}

function desajuste(clave: ClaveDeIdempotencia, registro: IdempotencyRecord): DomainError {
  return new DomainError(
    "IDEMPOTENCY_MISMATCH",
    `La cabecera ${CABECERA_CLAVE} '${clave.key}' ya se uso con un cuerpo distinto.`,
    {
      details: {
        idempotency_key: clave.key,
        // Los dos hashes, para que quien depura pueda ver cual de las dos
        // peticiones fue la que quedo guardada sin tener que adivinarlo.
        request_hash: clave.requestHash,
        stored_request_hash: registro.requestHash,
      },
      hint: "Usa una clave nueva para una peticion distinta, o reenvia el mismo cuerpo para recuperar la respuesta original.",
    },
  );
}

/**
 * La respuesta guardada, reconstruida.
 *
 * El cuerpo se serializa con `canonicalizar` y no con `JSON.stringify` porque
 * JSONB no conserva el orden de las claves: la fila vuelve de la base con las
 * claves reordenadas por longitud, asi que serializarla tal cual daria un texto
 * distinto al que se devolvio la primera vez. Con la forma canonica en los dos
 * lados, los bytes son los mismos.
 *
 * El X-Request-Id que lleva es el de ESTA peticion, no el de la original: es el
 * que correlaciona con lo que esta peticion registro en el log (6.1). El que
 * escribio el tablero esta en el registro de auditoria de la primera.
 */
export function respuestaReproducida(
  registro: IdempotencyRecord,
  ctx: ContextoPeticion,
): Response {
  return responderTexto(canonicalizar(registro.responseBody), registro.statusCode, ctx, {
    [CABECERA_REPLAY]: "true",
  });
}

/** Las cabeceras que le corresponden a una respuesta que SI se ejecuto. */
export function cabecerasDeEjecucion(idem: Idempotencia): Readonly<Record<string, string>> {
  return idem.tipo === "ejecutar" ? { [CABECERA_REPLAY]: "false" } : {};
}

/**
 * Resuelve la cabecera contra `idempotency_record` (6.5), antes de validar el
 * cuerpo.
 *
 * EL ORDEN IMPORTA Y ES DELIBERADO: primero la idempotencia, despues el esquema.
 * Los dos motivos:
 *
 *   - Una respuesta guardada se reproduce aunque el esquema haya cambiado desde
 *     que se guardo. Al reves, un endpoint que endureciera su validacion dejaria
 *     de poder devolver respuestas que ya emitio, que es exactamente lo que la
 *     6.5 promete que no pasa.
 *   - Reusar una clave con OTRO cuerpo es IDEMPOTENCY_MISMATCH aunque ese otro
 *     cuerpo tampoco sea valido. El 400 diria que el cuerpo esta mal; el 422 dice
 *     que la clave esta quemada, que es el problema que va a volver a aparecer
 *     en el reintento siguiente.
 */
export async function resolverIdempotencia(
  request: Request,
  cuerpo: unknown,
  auth: Autenticacion,
  buscar: BuscarRegistro,
): Promise<Idempotencia> {
  const key = leerClaveIdempotencia(request);

  if (key === undefined) {
    return { tipo: "sin-clave" };
  }

  const clave: ClaveDeIdempotencia = {
    key,
    // El prefijo publico de la API key: la segunda mitad de la PK compuesta, y
    // el mismo valor que `client_id` en el registro de auditoria.
    clientId: auth.clave.prefix,
    requestHash: hashDePeticion(request.method, new URL(request.url).pathname, cuerpo),
  };

  const registro = await buscar(clave.key, clave.clientId);

  if (registro === undefined) {
    return { tipo: "ejecutar", clave };
  }

  if (registro.requestHash !== clave.requestHash) {
    throw desajuste(clave, registro);
  }

  return { tipo: "reproducir", respuesta: respuestaReproducida(registro, auth) };
}

/**
 * La perdedora de dos peticiones simultaneas con la misma clave.
 *
 * Cuando llega aca, la ganadora YA commiteo: PostgreSQL bloquea el INSERT en
 * conflicto hasta que la otra transaccion termina, asi que la violacion de la PK
 * solo se levanta si la otra confirmo. O sea que el registro esta visible y se
 * puede leer sin carrera. La transaccion de esta peticion, en cambio, se fue
 * entera con el error: el tablero que alcanzo a crear no existe.
 *
 * Lo que devuelve es la respuesta de la ganadora, que es lo que el cliente
 * esperaba: mando dos veces la misma peticion y recibe dos veces la misma
 * respuesta. Si la ganadora hubiera mandado otro cuerpo con la misma clave, sale
 * el 422 de siempre.
 *
 * Devuelve undefined si el registro no aparece, que seria una violacion de esa
 * PK sin nadie del otro lado: no es esta carrera, y el error original tiene que
 * seguir subiendo en vez de quedar tapado.
 */
export async function reproducirTrasCarrera(
  clave: ClaveDeIdempotencia,
  ctx: ContextoPeticion,
  buscar: BuscarRegistro,
): Promise<Response | undefined> {
  const registro = await buscar(clave.key, clave.clientId);

  if (registro === undefined) {
    return undefined;
  }

  if (registro.requestHash !== clave.requestHash) {
    throw desajuste(clave, registro);
  }

  return respuestaReproducida(registro, ctx);
}
