import {
  columnaConOrden,
  crearColumna,
  parametrosDeTablero,
  type ColumnaConOrden,
} from "@taskman/contracts";
import {
  crearCorePort,
  violatesConstraint,
  IDEMPOTENCY_PK_CONSTRAINT,
  type Column,
  type ColumnWithOrder,
  type CreateColumnInput,
  type ParticipanteIdempotente,
} from "@taskman/core";

import { conAuth, contextoDeApi } from "../../../../../lib/auth.js";
import { aColumnaSalida } from "../../../../../lib/columnas.js";
import { type ContextoPeticion, leerCuerpo, responderTexto, respuestaDeError } from "../../../../../lib/http.js";
import {
  cabecerasDeEjecucion,
  canonicalizar,
  reproducirTrasCarrera,
  resolverIdempotencia,
} from "../../../../../lib/idempotencia.js";
import { registrarContratoRoto } from "../../../../../lib/log.js";

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

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
interface ContextoRuta {
  params: Promise<{ id: string }>;
}

/**
 * Valida la SALIDA y LANZA si no cumple el contrato que este endpoint publica.
 * Si deja de cumplirlo es un bug nuestro, asi que es un 500 y no una respuesta a
 * medias: devolver el cuerpo igual convertiria un error detectado en uno
 * silencioso que rompe al cliente mas lejos.
 *
 * Lanza en vez de devolver un Response porque el llamador puede ser el
 * participante de la 6.5, que corre DENTRO de la transaccion: ahi la unica forma
 * de no guardar un cuerpo que no podemos devolver es abortarla.
 */
function proyectarSalida(resultado: ColumnWithOrder, ctx: ContextoPeticion): ColumnaConOrden {
  const salida = columnaConOrden.safeParse({
    column: aColumnaSalida(resultado.column),
    columns: resultado.columns.map(aColumnaSalida),
  } satisfies ColumnaConOrden);

  if (!salida.success) {
    registrarContratoRoto(ctx.requestId, "POST /api/boards/{id}/columns", salida.error.issues);

    throw new Error("La salida no cumple el contrato.");
  }

  return salida.data;
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

  // El cuerpo se lee por un solo camino, con el tope de 256 KB de la 7.3: ver
  // `leerCuerpo`. Un cuerpo que no es JSON sigue siendo 400; uno que pasa el tope
  // es 413 y no se parsea.
  const leido = await leerCuerpo(request, auth);

  if (!leido.ok) {
    return leido.respuesta;
  }

  const cuerpo = leido.valor;

  /**
   * La idempotencia de la 6.5, ANTES de validar el cuerpo: ver
   * `resolverIdempotencia`. La ruta entra en el hash con el `{id}` del tablero
   * adentro, asi que la misma clave con el mismo cuerpo sobre OTRO tablero es
   * otra peticion, que es lo correcto: crearia otra columna.
   */
  const idem = await resolverIdempotencia(request, cuerpo, auth, (key, clientId) =>
    taskman.findIdempotencyRecord(key, clientId),
  );

  if (idem.tipo === "reproducir") {
    return idem.respuesta;
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

  /**
   * El participante de la 6.5. Recibe `ColumnWithOrder` —la columna creada y
   * TODAS las del tablero en su orden nuevo— porque eso es el cuerpo que este
   * endpoint responde, y ese orden solo esta completo DENTRO de la transaccion
   * que lo reescribio.
   */
  let salida: ColumnaConOrden | undefined;

  const participante: ParticipanteIdempotente<ColumnWithOrder> | undefined =
    idem.tipo === "ejecutar"
      ? async (resultado, escritura) => {
          salida = proyectarSalida(resultado, auth);
          await escritura.insertIdempotency({
            ...idem.clave,
            statusCode: 201,
            responseBody: salida,
          });
        }
      : undefined;

  let columna: Column;

  try {
    // BOARD_NOT_FOUND, DUPLICATE_KEY, COLUMN_KEY_REQUIRED, COLUMN_KEY_TOO_LONG,
    // NAME_REQUIRED, NAME_TOO_LONG e INVALID_ORDER salen de aca como DomainError y
    // los traduce el try/catch de `conAuth` con el mapeo de la 6.4. Envolverlos
    // aca duplicaria esa decision.
    columna = await taskman.createColumn(input, contextoDeApi(auth), participante);
  } catch (error: unknown) {
    // Dos peticiones simultaneas con la misma clave: esta perdio la PK y su
    // transaccion entera se revirtio. Ver `reproducirTrasCarrera`.
    if (idem.tipo === "ejecutar" && violatesConstraint(error, IDEMPOTENCY_PK_CONSTRAINT)) {
      const reproducida = await reproducirTrasCarrera(idem.clave, auth, (key, clientId) =>
        taskman.findIdempotencyRecord(key, clientId),
      );

      if (reproducida !== undefined) {
        return reproducida;
      }
    }

    throw error;
  }

  /**
   * Sin participante el tablero se RELEE despues de crear, y no es una consulta
   * de mas: insertar en una position intermedia reescribe la position de las
   * demas columnas, asi que el orden que hay que devolver solo existe despues de
   * la transaccion. CON participante ya vino de adentro, que ademas es el orden
   * que esta operacion produjo y no el que haya quedado despues.
   *
   * `getBoard` y no `getBoardWithTaskCounts`: los recuentos no entran en esta
   * respuesta (ver `columnaConOrden`), y pedirlos seria pagar el GROUP BY para
   * tirarlo.
   */
  const cuerpoSalida =
    salida ??
    proyectarSalida(
      { column: columna, columns: (await taskman.getBoard(parametros.data.id)).columns },
      auth,
    );

  // Serializado con `canonicalizar` siempre: es lo que hace que la respuesta
  // guardada y la reproducida sean el mismo texto byte a byte. La forma canonica
  // es RECURSIVA y NO reordena arrays, asi que el orden de `columns` —que es
  // dato, no presentacion— sobrevive el viaje por JSONB tal cual.
  // 201 y no 200: la 6.3.1 lo fija para los POST que crean un recurso.
  return responderTexto(canonicalizar(cuerpoSalida), 201, auth, cabecerasDeEjecucion(idem));
});
