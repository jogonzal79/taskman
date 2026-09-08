import { ApiKeyService, type ClaveAutenticada, type Scope } from "@taskman/core";

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
  const pepper = process.env["API_KEY_PEPPER"];

  if (pepper === undefined || pepper.trim() === "") {
    // Es un fallo de configuracion del servidor, no de quien llama: se
    // distingue de un 401 para no decirle a un cliente legitimo que su clave
    // esta mal cuando el problema es nuestro.
    throw new Error("API_KEY_PEPPER no esta definida en el entorno del servidor.");
  }

  return new ApiKeyService({ pepper });
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

function json(cuerpo: unknown, status: number): Response {
  return Response.json(cuerpo, { status, headers: { "Cache-Control": "no-store" } });
}

function noAutenticado(): Response {
  // 6.4: la envoltura es siempre la misma. Todavia sin `request_id`, que llega
  // con la cabecera X-Request-Id.
  return json(
    {
      error: {
        code: "UNAUTHENTICATED",
        message: "Falta la cabecera Authorization o la clave no es valida.",
        hint: "Envia la clave como 'Authorization: Bearer tmk_live_...'.",
      },
    },
    401,
  );
}

function scopeInsuficiente(requerido: ScopeHttp, tiene: readonly Scope[]): Response {
  return json(
    {
      error: {
        code: "FORBIDDEN_SCOPE",
        message: `La clave no tiene el scope '${requerido}', necesario para esta operacion.`,
        // 6.4: details indica el scope necesario. Va tambien lo que la clave SI
        // tiene, porque es lo que convierte el error en accionable sin tener
        // que ir a consultar la clave por otro lado.
        details: { required_scope: requerido, granted_scopes: tiene.map(aScopeHttp) },
        hint: "Emiti una clave nueva con ese scope; los scopes no se amplian sobre una existente.",
      },
    },
    403,
  );
}

/** Lo que el handler recibe ya autenticado. */
export interface Autenticacion {
  clave: ClaveAutenticada;
}

type Handler = (request: Request, auth: Autenticacion) => Promise<Response>;

/**
 * Envuelve un Route Handler con la autenticacion de la 7.1.
 *
 * El scope es un argumento OBLIGATORIO y no una opcion con valor por defecto: a
 * proposito. No se puede montar un endpoint sin declarar que scope exige, asi
 * que la forma de dejar una ruta abierta por descuido —olvidarse de llamar a un
 * helper— no existe. Falla cerrado.
 *
 * El proximo endpoint lo hereda envolviendose; no hay nada que copiar.
 */
export function conAuth(scope: ScopeHttp, handler: Handler) {
  return async function (request: Request): Promise<Response> {
    let servicio: ApiKeyService;

    try {
      servicio = crearServicio();
    } catch (error: unknown) {
      // Falta de configuracion del servidor: 500, y el detalle al stderr. Que
      // el pepper no este puesto no es culpa del cliente ni se le cuenta.
      console.error("[taskman-web] la autenticacion no esta configurada", error);
      return json(
        { error: { code: "INTERNAL_ERROR", message: "Fallo no controlado." } },
        500,
      );
    }

    const clave = leerBearer(request);
    if (clave === undefined) {
      return noAutenticado();
    }

    const resultado = await servicio.autenticar(clave, aScopeDeDominio(scope));

    if (resultado.ok) {
      return handler(request, { clave: resultado.clave });
    }

    if (resultado.motivo === "SCOPE_INSUFICIENTE") {
      return scopeInsuficiente(aScopeHttp(resultado.scopeRequerido), resultado.clave.scopes);
    }

    return noAutenticado();
  };
}
