import {
  ApiKeyService,
  type ActorContext,
  type ClaveAutenticada,
  type Scope,
} from "@taskman/core";

import {
  nuevoRequestId,
  respuestaDeError,
  respuestaDeFallo,
  type ContextoPeticion,
} from "./http.js";
import { registrarPeticion } from "./log.js";
import {
  consumir,
  CUBO_POR_SCOPE,
  VENTANA_MS,
  type LimiteSuperado,
} from "./rate-limit.js";

/**
 * Autenticacion por API key en el borde HTTP (ADR-005, 7.1 y 7.2).
 *
 * Reparto de responsabilidades (3.2): el nucleo decide si una clave es valida y
 * si alcanza para el scope pedido; este modulo solo lee la configuracion,
 * parsea la cabecera y traduce el resultado a la envoltura de la 6.4. No
 * importa Prisma ni sabe como se guarda una clave.
 */

/**
 * Los scopes en el borde van en minuscula (7.2); el enum de la base esta en
 * mayuscula. La traduccion vive aca, igual que la de snake_case: el nucleo
 * habla su vocabulario y el adaptador el del protocolo.
 */
const SCOPES_HTTP = { read: "READ", write: "WRITE", delete: "DELETE" } as const;

export type ScopeHttp = keyof typeof SCOPES_HTTP;

function aScopeDeDominio(scope: ScopeHttp): Scope {
  return SCOPES_HTTP[scope];
}

function aScopeHttp(scope: Scope): ScopeHttp {
  // El reverso se calcula y no se escribe a mano: una tabla duplicada es una
  // tabla que se desincroniza.
  const entrada = Object.entries(SCOPES_HTTP).find(([, dominio]) => dominio === scope);
  return (entrada?.[0] ?? scope.toLowerCase()) as ScopeHttp;
}

/**
 * El servicio se construye por peticion y no a nivel de modulo, a diferencia de
 * `crearCorePort()`: su constructor exige el pepper, y leerlo al importar el
 * modulo haria fallar `next build` al recolectar datos de la pagina, que es la
 * misma trampa que resolvio el proxy perezoso de packages/db.
 */
function crearServicio(): ApiKeyService {
  /**
   * El pepper NO se comprueba aca, y antes si: el esquema de la 11.2 lo exige al
   * arrancar (`lib/config.ts`), asi que un proceso que atiende peticiones ya lo
   * tiene. Lo que queda es el `?? ""`, que existe para el tipo y no para la
   * validacion.
   *
   * El vacio lo rechaza el CONSTRUCTOR del servicio, con un mensaje que nombra la
   * variable, y esa es la guarda que no se puede saltear: la ve tambien un script
   * o una prueba que construya el servicio sin pasar por el arranque. Un `if` aca
   * seria un tercer sitio diciendo lo mismo, y el unico que se podia borrar sin
   * perder nada.
   *
   * Sigue siendo un fallo de CONFIGURACION y no del llamador: sale por el 500 del
   * try/catch de `conAuth`, no por un 401, para no decirle a un cliente legitimo
   * que su clave esta mal cuando el problema es nuestro.
   */
  return new ApiKeyService({ pepper: process.env["API_KEY_PEPPER"] ?? "" });
}

/**
 * `Authorization: Bearer <clave>` (7.1). Devuelve undefined ante cualquier
 * forma que no sea exactamente esa: ausente, vacia, otro esquema, o "Bearer"
 * sin valor. Todas terminan en el mismo 401, porque para la 6.4 son el mismo
 * caso —falta la cabecera o no sirve— y no hay nada que un cliente gane
 * sabiendo cual de las variantes escribio mal.
 */
function leerBearer(request: Request): string | undefined {
  const cabecera = request.headers.get("authorization");

  if (cabecera === null) {
    return undefined;
  }

  // El esquema es insensible a mayusculas por RFC 7235; el token no.
  const separador = cabecera.indexOf(" ");
  if (separador === -1) {
    return undefined;
  }

  const esquema = cabecera.slice(0, separador);
  const valor = cabecera.slice(separador + 1).trim();

  if (esquema.toLowerCase() !== "bearer" || valor === "") {
    return undefined;
  }

  return valor;
}

function noAutenticado(ctx: ContextoPeticion): Response {
  return respuestaDeError(
    "UNAUTHENTICATED",
    "Falta la cabecera Authorization o la clave no es valida.",
    401,
    ctx,
    { hint: "Envia la clave como 'Authorization: Bearer tmk_live_...'." },
  );
}

/**
 * El 429 de la 7.3, con la envoltura de la 6.4 y `Retry-After` en SEGUNDOS,
 * que es una de las dos formas que permite HTTP (la otra es una fecha) y la que
 * un cliente puede usar sin mirar su propio reloj.
 *
 * `details` lleva cual de los dos cupos se agoto y cuanto vale, para que quien
 * lo reciba pueda ajustar su ritmo sin ir a leer la especificacion.
 */
function limiteSuperado(veredicto: LimiteSuperado, ctx: ContextoPeticion): Response {
  return respuestaDeError(
    "RATE_LIMITED",
    `Se supero el limite de ${veredicto.limite} peticiones por minuto de ${veredicto.nombreHttp} de esta clave.`,
    429,
    ctx,
    {
      details: {
        bucket: veredicto.nombreHttp,
        limit: veredicto.limite,
        window_seconds: VENTANA_MS / 1000,
        retry_after_seconds: veredicto.esperaSegundos,
      },
      hint: `Espera ${veredicto.esperaSegundos} segundos y reintenta; el cupo se libera de a una peticion.`,
      cabeceras: { "Retry-After": String(veredicto.esperaSegundos) },
    },
  );
}

function scopeInsuficiente(
  requerido: ScopeHttp,
  tiene: readonly Scope[],
  ctx: ContextoPeticion,
): Response {
  return respuestaDeError(
    "FORBIDDEN_SCOPE",
    `La clave no tiene el scope '${requerido}', necesario para esta operacion.`,
    403,
    ctx,
    {
      // 6.4: details indica el scope necesario. Va tambien lo que la clave SI
      // tiene, porque es lo que convierte el error en accionable sin tener que
      // ir a consultar la clave por otro lado.
      details: { required_scope: requerido, granted_scopes: tiene.map(aScopeHttp) },
      hint: "Emiti una clave nueva con ese scope; los scopes no se amplian sobre una existente.",
    },
  );
}

/** Lo que el handler recibe ya autenticado, mas el contexto de la peticion. */
export interface Autenticacion extends ContextoPeticion {
  clave: ClaveAutenticada;
}

/**
 * El `ActorContext` de una peticion REST (7.4), para las operaciones que
 * escriben.
 *
 * `actorType` es API por construccion, igual que `contextoDeAgente` fija AGENT:
 * todo lo que pasa por aca entro por HTTP con una API key, asi que un handler
 * no puede registrarse como otra cosa ni por error ni a proposito.
 *
 * Va como funcion y no como un campo mas de `Autenticacion` porque solo las
 * ESCRITURAS lo necesitan (7.4: las lecturas no se auditan). Es la misma
 * asimetria que ya tienen los servicios y el puerto: armarlo en `conAuth`
 * dejaria a cada endpoint de lectura cargando un contexto que nadie lee.
 *
 * A diferencia de `contextoDeAgente`, aca NO hay que recortar nada, y no es por
 * descuido: los tres valores salen de columnas mas angostas que las de
 * `audit_log`. `api_key.label` es VARCHAR(80) contra el VARCHAR(120) de
 * `actor_name`, `api_key.prefix` es VARCHAR(24) contra el VARCHAR(120) de
 * `client_id`, y el requestId de `nuevoRequestId()` mide 36 caracteres fijos
 * contra el VARCHAR(64) de `request_id`. Lo que recorta el borde MCP es el
 * nombre que declara un cliente cualquiera; esto son datos nuestros. Si alguna
 * de esas tres columnas se ensancha por encima de la de `audit_log`, el
 * sintoma va a ser un 500 en cada escritura —el INSERT de auditoria falla con
 * 22001 y por la 7.4 se lleva la operacion entera—, ruidoso y no silencioso.
 */
export function contextoDeApi(auth: Autenticacion): ActorContext {
  return {
    actorType: "API",
    // La etiqueta y no el prefijo: es el nombre que eligio una persona al
    // emitir la clave, que es lo que hace legible el registro. Cual de las
    // claves fue va en `clientId`, que es justo lo que pide la 5.1.
    actorName: auth.clave.label,
    clientId: auth.clave.prefix,
    requestId: auth.requestId,
  };
}

/**
 * Los argumentos extra son los que Next le pasa al handler despues del
 * Request: en una ruta dinamica, el contexto con los `params`. `conAuth` no
 * los mira, solo los reenvia, asi que sirve igual para un endpoint con
 * parametros de ruta y para uno sin ellos sin saber cual es cual.
 */
type Handler<Args extends unknown[]> = (
  request: Request,
  auth: Autenticacion,
  ...args: Args
) => Promise<Response>;

/**
 * Envuelve un Route Handler con la autenticacion de la 7.1 y el request_id de
 * la 6.1.
 *
 * El scope es un argumento OBLIGATORIO y no una opcion con valor por defecto: a
 * proposito. No se puede montar un endpoint sin declarar que scope exige, asi
 * que la forma de dejar una ruta abierta por descuido —olvidarse de llamar a un
 * helper— no existe. Falla cerrado.
 *
 * Tambien es el unico try/catch del borde: cualquier fallo que escape del
 * handler sale por `respuestaDeFallo`, o sea con la envoltura de la 6.4 y con
 * el mismo request_id que ya viajo en la cabecera. Ponerlo aca y no en cada
 * handler es lo que evita que un endpoint nuevo se olvide de traducir sus
 * errores de dominio.
 */
export function conAuth<Args extends unknown[]>(scope: ScopeHttp, handler: Handler<Args>) {
  return async function (request: Request, ...args: Args): Promise<Response> {
    // Se genera antes que nada: hasta un fallo de configuracion tiene que salir
    // con su X-Request-Id para poder correlacionarlo con el log.
    const ctx: ContextoPeticion = { requestId: nuevoRequestId() };
    const inicio = Date.now();

    const atencion = await atender(scope, handler, request, ctx, args);

    /**
     * UNA linea por peticion (11.1), y aca porque es el unico punto por el que
     * salen TODAS: el 401 que no llego a autenticar, el 403, el 429, lo que
     * devuelva el handler y el 500 del catch. Registrar dentro de `atender`
     * obligaria a acordarse en cada `return`, que es la forma de que al 401 le
     * falte la linea justo cuando es la que uno fue a buscar.
     *
     * El estado y la duracion solo se saben aca, y el prefijo de la clave solo
     * existe si la peticion autentico: `atender` lo devuelve junto con la
     * respuesta en vez de dejarlo en una variable mutable.
     */
    registrarPeticion({
      requestId: ctx.requestId,
      metodo: request.method,
      ruta: new URL(request.url).pathname,
      status: atencion.respuesta.status,
      duracionMs: Date.now() - inicio,
      clientId: atencion.clientId,
    });

    return atencion.respuesta;
  };
}

/** La respuesta, mas el prefijo de la clave si la peticion llego a autenticar. */
interface Atencion {
  readonly respuesta: Response;
  readonly clientId: string | null;
}

/**
 * El cuerpo de `conAuth`. NUNCA lanza: todo camino termina en una `Response`, que
 * es lo que permite que la linea de log de arriba sea incondicional.
 */
async function atender<Args extends unknown[]>(
  scope: ScopeHttp,
  handler: Handler<Args>,
  request: Request,
  ctx: ContextoPeticion,
  args: Args,
): Promise<Atencion> {
  let clientId: string | null = null;

  try {
    const servicio = crearServicio();

    const clave = leerBearer(request);
    if (clave === undefined) {
      return { respuesta: noAutenticado(ctx), clientId };
    }

      const resultado = await servicio.autenticar(clave, aScopeDeDominio(scope));

      /**
       * El limite de la 7.3, DESPUES de autenticar y ANTES de resolver el scope.
       *
       * Despues de autenticar porque el limite es POR CLAVE: no hay a quien
       * cobrarle la peticion hasta saber cual es. Eso deja fuera del limite a las
       * peticiones que no autentican, y esta bien que queden fuera: acotarlas
       * seria un limite por IP, que la 7.3 no pide y que con una sola clave
       * detras de un proxy haria mas dano que bien.
       *
       * Antes del scope porque un cliente en bucle de 403 sigue siendo un cliente
       * en bucle: el cupo acota el VOLUMEN que una clave puede causar, y ese
       * volumen es real tanto si el scope alcanzaba como si no. Al reves —el 403
       * primero— un bucle de scope equivocado no se acotaria nunca. La
       * consecuencia es que una clave sin scope y sin cupo recibe 429 y no 403, y
       * es el orden correcto de las dos noticias: en cuanto baje el ritmo se
       * encuentra con el 403 y arregla lo otro.
       *
       * El cupo lo elige el SCOPE del endpoint, no su metodo: ver CUBO_POR_SCOPE.
       */
    if (resultado.ok || resultado.motivo === "SCOPE_INSUFICIENTE") {
      // Desde aca la peticion ya tiene una clave identificada, asi que su linea
      // de log la lleva: un 403 y un 429 SI dicen de quien fueron.
      clientId = resultado.clave.prefix;

      const veredicto = consumir(resultado.clave.id, CUBO_POR_SCOPE[scope]);

      if (!veredicto.permitido) {
        return { respuesta: limiteSuperado(veredicto, ctx), clientId };
      }
    }

    if (resultado.ok) {
      return {
        respuesta: await handler(request, { ...ctx, clave: resultado.clave }, ...args),
        clientId,
      };
    }

    if (resultado.motivo === "SCOPE_INSUFICIENTE") {
      return {
        respuesta: scopeInsuficiente(
          aScopeHttp(resultado.scopeRequerido),
          resultado.clave.scopes,
          ctx,
        ),
        clientId,
      };
    }

    return { respuesta: noAutenticado(ctx), clientId };
  } catch (error: unknown) {
    return { respuesta: respuestaDeFallo(error, ctx), clientId };
  }
}
