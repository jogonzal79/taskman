import { z } from "zod";

/**
 * La envoltura UNICA de error de la 6.4, y el catalogo de codigos con su estado
 * HTTP.
 *
 * Estaba escrita como una interfaz de TypeScript en `apps/web/lib/http.ts`
 * (`CuerpoError`) y en ningun esquema, asi que el borde de errores era la unica
 * parte del contrato HTTP que no se podia derivar (ADR-006). El generador de
 * OpenAPI la necesita para describir las respuestas de error de los 17
 * endpoints, y la alternativa era escribirla a mano DENTRO del generador: dos
 * copias igual, pero la segunda sin forma de que nadie la reutilice. Vive aca
 * por lo mismo que el resto: este paquete es el que documenta el borde.
 *
 * `details` es SIEMPRE estructurado (6.4) para que un agente pueda reaccionar
 * de forma programatica, y por eso es un objeto y no texto.
 */
export const errorDeApi = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    hint: z.string().optional(),
    /** Coincide con la cabecera X-Request-Id de la respuesta (6.1). */
    request_id: z.string(),
  }),
});

export type ErrorDeApi = z.infer<typeof errorDeApi>;

/**
 * Codigo de error -> estado HTTP. Es la tabla de la 6.4 mas los codigos de
 * dominio que la 6.4 no enumera y el nucleo si produce (TITLE_TOO_LONG,
 * INVALID_ORDER, ...).
 *
 * `code` en el esquema de arriba es `z.string()` y NO un enum de estas claves, a
 * proposito: el conjunto real lo define `DomainErrorCode` en `packages/core`,
 * este paquete es una hoja del grafo (3.3) y no puede importarlo. Un enum aca
 * seria una tercera copia que se cree autoridad; este mapa no pretende ser la
 * fuente de los codigos, solo del estado con el que cada uno sale al protocolo.
 *
 * CONSECUENCIA CONOCIDA: `apps/web/lib/http.ts` mantiene su propio
 * `HTTP_POR_CODIGO`, que si es exhaustivo sobre `DomainErrorCode` por typecheck.
 * Mientras las dos existan tienen que coincidir, y nada lo comprueba.
 */
export const ESTADO_POR_CODIGO = {
  VALIDATION_ERROR: 400,
  TITLE_REQUIRED: 400,
  TITLE_TOO_LONG: 400,
  NAME_REQUIRED: 400,
  NAME_TOO_LONG: 400,
  DESCRIPTION_TOO_LONG: 400,
  COLUMN_KEY_REQUIRED: 400,
  COLUMN_KEY_TOO_LONG: 400,
  INVALID_ORDER: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_SCOPE: 403,
  DESTRUCTIVE_POLICY_DENIED: 403,
  BOARD_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  COLUMN_NOT_IN_BOARD: 409,
  AMBIGUOUS_MATCH: 409,
  COLUMN_NOT_EMPTY: 409,
  INVALID_REASSIGN_TARGET: 409,
  DUPLICATE_KEY: 409,
  IDEMPOTENCY_MISMATCH: 422,
  CONFIRMATION_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type CodigoDeError = keyof typeof ESTADO_POR_CODIGO;
