import { salud, saludDegradada, type Salud, type SaludDegradada } from "@taskman/contracts";
import { comprobarConexion } from "@taskman/core";

import {
  nuevoRequestId,
  responder,
  respuestaDeFallo,
  type ContextoPeticion,
} from "../../../lib/http";
import {
  registrarContratoRoto,
  registrarPeticion,
  registrarSondaCaida,
} from "../../../lib/log";
import { VERSION } from "../../../lib/version";

/**
 * GET /api/health (6.2): sonda de salud, sin autenticacion. Comprueba
 * conectividad con la base y devuelve la version desplegada (11.1).
 *
 * El adaptador no ve Prisma: llama a `comprobarConexion` del nucleo y solo
 * traduce el resultado al protocolo (3.2). El plazo de la sonda tampoco se
 * maneja aca; vive en el nucleo, que es quien conoce el driver.
 *
 * Es el unico endpoint sin `conAuth`, y eso es TODO lo que lo hace distinto: no
 * autentica (6.2), asi que no tiene 401, 403 ni el 429 de la 7.3, que se cobra
 * por clave. Lo que ya NO lo distingue es el X-Request-Id: la 6.1 lo pide en
 * TODA respuesta sin excepcion, y el request_id se genera aca igual que en
 * `conAuth`, con la misma funcion. Tampoco lo distingue el cuerpo, que ahora sale
 * de los esquemas de `packages/contracts` como el de los otros dieciseis.
 */

// Una sonda de salud cacheada responde por el estado de otro momento, que es
// justo lo que no sirve. `force-dynamic` la saca del cache de Next y el
// no-store del de cualquier proxy que haya delante.
export const dynamic = "force-dynamic";

type Sonda = { readonly ok: true; readonly latencyMs: number } | { readonly ok: false };

/**
 * Envuelve SOLO la llamada a la base, y ahi esta la gracia del corte.
 *
 * Si el try abarcara tambien la proyeccion y la validacion de la salida, un
 * cuerpo que no cumple el contrato saldria como un 503: el endpoint diria que la
 * base esta caida cuando lo que falla es nuestro codigo, y la sonda mentiria
 * sobre justo lo que vino a vigilar. Asi, un fallo de contrato sale por el
 * try/catch de afuera, que lo traduce al 500 de la 6.4.
 */
async function sondear(ctx: ContextoPeticion): Promise<Sonda> {
  const inicio = Date.now();

  try {
    await comprobarConexion();

    // Date.now() ya son milisegundos enteros; la resta tambien.
    return { ok: true, latencyMs: Date.now() - inicio };
  } catch (error: unknown) {
    // El detalle va al LOG y NUNCA al cuerpo: el mensaje del driver lleva host,
    // puerto, base y usuario de la cadena de conexion, y este endpoint no pide
    // autenticacion. El request_id es lo que permite correlacionar esta linea con
    // la respuesta que la persona esta mirando.
    registrarSondaCaida(ctx.requestId, error);

    return { ok: false };
  }
}

/**
 * LANZA si la salida no cumple el contrato, igual que los demas endpoints:
 * devolver el cuerpo igual convertiria un error detectado en uno silencioso que
 * rompe al cliente mas lejos. El try/catch del handler lo traduce al 500 de la
 * 6.4 con el mismo request_id que ya viajo en la cabecera.
 *
 * Devuelve `never` para que el llamador quede estrechado despues de llamarla, sin
 * un `else`. No se generaliza a "valida con este esquema" porque eso necesitaria
 * los tipos de Zod y `apps/web` NO depende de zod: lo hace a traves de
 * `@taskman/contracts`, que es el que documenta el borde, y agregar la
 * dependencia para un tipo generico seria pagar un import por comodidad.
 */
function contratoRoto(ctx: ContextoPeticion, issues: unknown): never {
  registrarContratoRoto(ctx.requestId, "GET /api/health", issues);

  throw new Error("La salida no cumple el contrato.");
}

async function atender(ctx: ContextoPeticion): Promise<Response> {
  try {
    const sonda = await sondear(ctx);

    if (!sonda.ok) {
      const cuerpo: SaludDegradada = { status: "degraded", version: VERSION, database: { ok: false } };
      const salida = saludDegradada.safeParse(cuerpo);

      if (!salida.success) {
        contratoRoto(ctx, salida.error.issues);
      }

      return responder(salida.data, 503, ctx);
    }

    const cuerpo: Salud = {
      status: "ok",
      version: VERSION,
      database: { ok: true, latency_ms: sonda.latencyMs },
    };
    const salida = salud.safeParse(cuerpo);

    if (!salida.success) {
      contratoRoto(ctx, salida.error.issues);
    }

    return responder(salida.data, 200, ctx);
  } catch (error: unknown) {
    return respuestaDeFallo(error, ctx);
  }
}

export async function GET(): Promise<Response> {
  // Se genera antes que nada y con la misma funcion que `conAuth`: hasta un fallo
  // de contrato tiene que salir con su X-Request-Id para poder correlacionarlo
  // con el log.
  const ctx: ContextoPeticion = { requestId: nuevoRequestId() };
  const inicio = Date.now();

  const respuesta = await atender(ctx);

  /**
   * La linea por peticion de la 11.1, tambien aca. Este endpoint no pasa por
   * `conAuth` —es el unico sin autenticacion (6.2)— asi que si no la registrara
   * el, la sonda seria lo unico invisible en el log, que es justo lo que uno mira
   * cuando quiere saber si el servicio estaba vivo.
   *
   * `metodo` y `ruta` van literales porque el handler NO recibe el Request, y esa
   * ausencia es deliberada: es la garantia de que no puede leer la cabecera
   * Authorization ni por error. `clientId` en null porque no hay clave que
   * identificar.
   */
  registrarPeticion({
    requestId: ctx.requestId,
    metodo: "GET",
    ruta: "/api/health",
    status: respuesta.status,
    duracionMs: Date.now() - inicio,
    clientId: null,
  });

  return respuesta;
}
