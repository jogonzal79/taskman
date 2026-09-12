import { ESTADO_POR_CODIGO, type CodigoDeError } from "../error.js";
import { componentesDeEsquema, parametrosDe, ref } from "./componentes.js";
import { esObjeto, type ObjetoJson } from "./json.js";
import { RUTAS, type Ruta } from "./rutas.js";

export { serializarEstable } from "./json.js";

/**
 * Generador del documento OpenAPI 3.1 de la API REST, en tiempo de compilacion
 * (ADR-006). No lee ni escribe archivos: devuelve el documento, y `build.mjs` lo
 * escribe en la raiz del repo.
 *
 * Todo lo que describe una FORMA —campos, tipos, topes, obligatoriedad,
 * enumeraciones— sale de los esquemas Zod de este paquete, que son los mismos
 * con los que los handlers validan. Lo que no puede salir de un esquema esta en
 * `rutas.ts` y es cableado, no contrato: metodo, ruta, scope y que esquema va en
 * cada sitio.
 */

/** OpenAPI exige una descripcion por respuesta; estas son las frases estandar. */
const FRASE_POR_ESTADO: Readonly<Record<number, string>> = {
  200: "Correcto.",
  201: "Creado.",
  204: "Sin contenido.",
  400: "Peticion invalida.",
  401: "No autenticado.",
  403: "Prohibido.",
  404: "No encontrado.",
  409: "Conflicto.",
  422: "Entidad no procesable.",
  428: "Se requiere confirmacion.",
  429: "Demasiadas peticiones.",
  500: "Error interno.",
  503: "Servicio no disponible.",
};

function frase(estado: number): string {
  const texto = FRASE_POR_ESTADO[estado];

  if (texto === undefined) {
    throw new Error(`Falta la frase del estado ${estado} en FRASE_POR_ESTADO.`);
  }

  return texto;
}

/**
 * `postTasksByIdMove` a partir de `post /api/tasks/{id}/move`. Mecanico: sale de
 * la ruta, asi que no hay una segunda lista de nombres que mantener.
 */
function operationId(ruta: Ruta): string {
  const segmentos = ruta.ruta
    .split("/")
    .filter((segmento) => segmento !== "" && segmento !== "api")
    .map((segmento) =>
      segmento.startsWith("{") ? `By${capitalizar(segmento.slice(1, -1))}` : capitalizar(segmento),
    );

  return ruta.metodo + segmentos.join("");
}

function capitalizar(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** El recurso al que pertenece la ruta: el primer segmento despues de /api. */
function etiqueta(ruta: Ruta): string {
  const segmento = ruta.ruta.split("/")[2];

  if (segmento === undefined) {
    throw new Error(`La ruta ${ruta.ruta} no tiene un segmento de recurso.`);
  }

  return segmento;
}

/**
 * Los codigos de error de un endpoint: los propios de la tabla mas los que se
 * deducen de como esta declarado.
 *
 * Deducidos y no escritos endpoint por endpoint: UNAUTHENTICATED y
 * FORBIDDEN_SCOPE los puede devolver cualquiera que exija scope (7.2),
 * VALIDATION_ERROR cualquiera que reciba entrada, INTERNAL_ERROR cualquiera que
 * pase por el try/catch del adaptador, e IDEMPOTENCY_MISMATCH solo los tres de
 * la 6.5. Repetirlos 16 veces en la tabla seria repetir 16 veces la misma regla.
 */
function erroresDe(ruta: Ruta): readonly CodigoDeError[] {
  // GET /api/health no autentica y no arma la envoltura de la 6.4.
  if (ruta.scope === null) {
    return [];
  }

  const codigos: CodigoDeError[] = [];

  if (ruta.path !== undefined || ruta.consulta !== undefined || ruta.cuerpo !== undefined) {
    codigos.push("VALIDATION_ERROR");
  }

  codigos.push("UNAUTHENTICATED", "FORBIDDEN_SCOPE", ...(ruta.errores ?? []));

  if (ruta.idempotente === true) {
    codigos.push("IDEMPOTENCY_MISMATCH");
  }

  codigos.push("INTERNAL_ERROR");

  return codigos;
}

const CABECERA_REQUEST_ID = { "X-Request-Id": { $ref: "#/components/headers/XRequestId" } };

const CABECERA_REPLAYED = {
  "Idempotency-Replayed": { $ref: "#/components/headers/IdempotencyReplayed" },
};

/**
 * Las respuestas de una operacion: las que declara la tabla, mas una por cada
 * estado HTTP al que mapea algun codigo de error del endpoint.
 *
 * Toda respuesta lleva X-Request-Id salvo las de /api/health, que es el unico
 * endpoint que no pasa por el adaptador que la emite (6.1).
 */
function respuestasDe(ruta: Ruta): ObjetoJson {
  const conRequestId = ruta.scope !== null;
  const respuestas: ObjetoJson = {};

  for (const respuesta of ruta.respuestas) {
    const exito = respuesta.estado < 300 && respuesta.estado >= 200;

    respuestas[String(respuesta.estado)] = {
      description: frase(respuesta.estado),
      ...(conRequestId
        ? {
            headers: {
              ...CABECERA_REQUEST_ID,
              ...(ruta.idempotente === true && exito ? CABECERA_REPLAYED : {}),
            },
          }
        : {}),
      ...(respuesta.componente === undefined
        ? {}
        : { content: { "application/json": { schema: ref(respuesta.componente) } } }),
    };
  }

  const porEstado = new Map<number, CodigoDeError[]>();

  for (const codigo of erroresDe(ruta)) {
    const estado = ESTADO_POR_CODIGO[codigo];
    const codigos = porEstado.get(estado);

    if (codigos === undefined) {
      porEstado.set(estado, [codigo]);
    } else {
      codigos.push(codigo);
    }
  }

  for (const [estado, codigos] of porEstado) {
    respuestas[String(estado)] = {
      description: `${frase(estado)} Codigos: ${codigos.join(", ")}.`,
      headers: { ...CABECERA_REQUEST_ID },
      content: { "application/json": { schema: ref("ErrorDeApi") } },
    };
  }

  return respuestas;
}

function parametrosDeRuta(ruta: Ruta): readonly ObjetoJson[] {
  const parametros: ObjetoJson[] = [];

  if (ruta.path !== undefined) {
    parametros.push(...parametrosDe(ruta.path, "path"));
  }

  if (ruta.consulta !== undefined) {
    parametros.push(...parametrosDe(ruta.consulta, "query"));
  }

  if (ruta.idempotente === true) {
    parametros.push({ $ref: "#/components/parameters/IdempotencyKey" });
  }

  return parametros;
}

/**
 * La descripcion de la operacion se ARMA con los campos de la tabla, no se
 * escribe: asi el scope que exige cada endpoint queda visible tambien para quien
 * lee el documento y no solo en `x-taskman-scope`, y no hay dos sitios que
 * puedan decir cosas distintas.
 */
function descripcionDe(ruta: Ruta): string {
  const partes: string[] = [];

  partes.push(
    ruta.scope === null
      ? "Sin autenticacion (6.2)."
      : `Requiere una API key con scope \`${ruta.scope}\` (7.2).`,
  );

  if (ruta.idempotente === true) {
    partes.push("Acepta la cabecera `Idempotency-Key` (6.5).");
  }

  if (ruta.rf !== undefined) {
    partes.push(`Requisito funcional: ${ruta.rf.join(", ")}.`);
  }

  return partes.join(" ");
}

function operacion(ruta: Ruta): ObjetoJson {
  const parametros = parametrosDeRuta(ruta);

  return {
    operationId: operationId(ruta),
    summary: ruta.resumen,
    description: descripcionDe(ruta),
    tags: [etiqueta(ruta)],
    ...(ruta.scope === null ? { security: [] } : { "x-taskman-scope": ruta.scope }),
    ...(parametros.length === 0 ? {} : { parameters: parametros }),
    ...(ruta.cuerpo === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref(ruta.cuerpo) } },
          },
        }),
    responses: respuestasDe(ruta),
  };
}

function paths(): ObjetoJson {
  const rutas: ObjetoJson = {};

  for (const ruta of RUTAS) {
    const existente = rutas[ruta.ruta];
    // Un mismo path junta varias operaciones: /api/boards lleva get y post.
    const item: ObjetoJson = esObjeto(existente) ? existente : {};

    item[ruta.metodo] = operacion(ruta);
    rutas[ruta.ruta] = item;
  }

  return rutas;
}

/** Un tag por recurso, en el orden en que aparece en la tabla. */
function tags(): readonly ObjetoJson[] {
  const nombres: string[] = [];

  for (const ruta of RUTAS) {
    const nombre = etiqueta(ruta);

    if (!nombres.includes(nombre)) {
      nombres.push(nombre);
    }
  }

  return nombres.map((nombre) => ({ name: nombre }));
}

/**
 * Lo que este documento NO puede decir, anotado donde se lee.
 *
 * Cada linea se borra en el mismo commit que la arregla, igual que la deuda
 * conocida de CLAUDE.md: describen huecos de la derivacion, no del generador.
 */
const LIMITES = [
  "Las reglas ENTRE campos no aparecen: Zod las expresa con `.refine()` y JSON Schema no puede representarlas. Afecta a `board_id` o `column_id` en GET /api/tasks y GET /api/tasks/search, a `entity_type` junto a `entity_id` en GET /api/audit, y a `column_id` o `column_key` en POST /api/tasks y POST /api/tasks/{id}/move.",
  "Los topes de longitud de nombre, titulo y descripcion tampoco: se validan en PUNTOS DE CODIGO con `.refine()`, asi que no salen como `maxLength`.",
  "El cuerpo de GET /api/health no tiene esquema Zod, asi que su respuesta se declara sin `content`.",
  "Las cabeceras (X-Request-Id, Idempotency-Key, Idempotency-Replayed) tampoco tienen esquema Zod: su forma se declara en el generador.",
];

export interface OpcionesDelDocumento {
  /** La version de `packages/contracts`, que es lo que este documento describe. */
  readonly version: string;
}

export function documentoOpenApi(opciones: OpcionesDelDocumento): ObjetoJson {
  return {
    openapi: "3.1.0",
    info: {
      title: "TaskMan API",
      version: opciones.version,
      summary: "API REST del gestor de tareas Kanban TaskMan.",
      description: [
        "GENERADO desde los esquemas Zod de `packages/contracts` (ADR-006). No lo edites a mano: se reescribe en cada compilacion.",
        "El contrato completo esta en la seccion 6 de `docs/especificacion-tecnica-v1.0.md`; la autenticacion en la 7.1 y los scopes en la 7.2.",
        "Limites de la derivacion:",
        ...LIMITES.map((limite) => `- ${limite}`),
      ].join("\n\n"),
    },
    // Relativo a proposito: el host depende del despliegue (11.3) y no sale de
    // ningun esquema. `/api` ya esta en cada ruta.
    servers: [{ url: "/", description: "El mismo origen que sirve la UI." }],
    security: [{ bearerApiKey: [] }],
    tags: tags(),
    paths: paths(),
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: [
            "API key de la 7.1, con el formato `tmk_live_` mas 32 bytes en base62:",
            "`Authorization: Bearer tmk_live_...`.",
            "El scope que exige cada operacion esta en su `x-taskman-scope` (7.2).",
            "OpenAPI no sabe declarar scopes sobre un esquema `http`, solo sobre OAuth2, asi que no van en `security`.",
          ].join(" "),
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "Idempotencia de la 6.5. Con la misma clave y el mismo cuerpo se devuelve la respuesta guardada; con la misma clave y otro cuerpo, 422 IDEMPOTENCY_MISMATCH. La clave identifica un INTENTO DE OPERACION, asi que reusarla en otro endpoint tambien es 422.",
          schema: { type: "string" },
        },
      },
      headers: {
        XRequestId: {
          description:
            "Identificador de correlacion (6.1). Coincide con el `request_id` del cuerpo de error, del registro de auditoria y del log.",
          schema: { type: "string" },
          required: true,
        },
        IdempotencyReplayed: {
          description:
            "Solo si la peticion llevo `Idempotency-Key`: `true` si la respuesta se reprodujo de `idempotency_record` sin ejecutar nada, `false` si la operacion se ejecuto (6.5).",
          schema: { type: "string", enum: ["true", "false"] },
          required: false,
        },
      },
      schemas: componentesDeEsquema(),
    },
  };
}
