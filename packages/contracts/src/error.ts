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
 * Codigo de error -> estado HTTP. LA UNICA tabla: es la de la 6.4 mas los codigos
 * de dominio que la 6.4 no enumera y el nucleo si produce (TITLE_TOO_LONG,
 * INVALID_ORDER, ...), y `apps/web/lib/http.ts` la consume en vez de tener la
 * suya.
 *
 * `code` en el esquema de arriba es `z.string()` y NO un enum de estas claves, a
 * proposito: el conjunto real lo define `DomainErrorCode` en `packages/core`,
 * este paquete es una hoja del grafo (3.3) y no puede importarlo. Un enum aca
 * seria una tercera copia que se cree autoridad; este mapa no pretende ser la
 * fuente de los codigos, solo del estado con el que cada uno sale al protocolo.
 *
 * DE ESO SALE LA DIRECCION DE LA DERIVACION, y conviene entenderla antes de
 * tocar nada. Contracts no puede mirar hacia el nucleo, asi que la tabla no puede
 * declararse exhaustiva aca; el unico sitio que ve las dos cosas es el adaptador,
 * que importa `DomainErrorCode` y este mapa. Por eso `http.ts` no copia: anota
 * `const HTTP_POR_CODIGO: Record<DomainErrorCode, number> = ESTADO_POR_CODIGO`, y
 * esa anotacion ES la comprobacion. Un codigo de dominio nuevo sin entrada ACA no
 * compila ALLA, con el mensaje apuntando al que falta.
 *
 * Corolario: las claves que no son codigos de dominio —hoy INTERNAL_ERROR, la
 * etiqueta de un fallo no controlado, y FORBIDDEN_ORIGIN, que es del transporte
 * de /mcp— sobran respecto de ese `Record` y esta bien que sobren: asignar una
 * variable (no un literal) no dispara la comprobacion de propiedades en exceso,
 * asi que la tabla puede ser mas ancha que el dominio sin dejar de cubrirlo
 * entero. UNAUTHENTICATED, FORBIDDEN_SCOPE, RATE_LIMITED y PAYLOAD_TOO_LARGE
 * tambien los produce el borde, pero desde el paso 11 de F4 son del catalogo de
 * dominio (ver la nota del 413, abajo).
 */
export const ESTADO_POR_CODIGO = {
  // --- 400 ---------------------------------------------------------------
  VALIDATION_ERROR: 400,

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

  // --- 401 y 403 ---------------------------------------------------------
  UNAUTHENTICATED: 401,
  FORBIDDEN_SCOPE: 403,

  // Una peticion a /mcp con un Origin que no esta permitido. No lo pide la
  // especificacion del proyecto sino el protocolo: Streamable HTTP exige validar
  // Origin contra DNS rebinding y responder 403 cuando es invalido. Es del BORDE
  // MCP, como PAYLOAD_TOO_LARGE lo es del HTTP, y REST no lo produce: /api no lo
  // valida porque la 7.3 resuelve el caso del navegador con CORS apagado.
  FORBIDDEN_ORIGIN: 403,

  // MCP_DESTRUCTIVE_POLICY=deny: el servidor no borra, se pida como se pida. No
  // lo puede producir REST hoy —es del borde MCP— pero el `Record` del adaptador
  // obliga a decidirlo igual, que es justamente la gracia. 403 y no 405: el
  // metodo existe, lo que falta es permiso.
  DESTRUCTIVE_POLICY_DENIED: 403,
  // --- 404 ---------------------------------------------------------------
  BOARD_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  // --- 409 ---------------------------------------------------------------
  COLUMN_NOT_IN_BOARD: 409,
  AMBIGUOUS_MATCH: 409,
  COLUMN_NOT_EMPTY: 409,

  // reassignTo apuntando a la columna que se esta borrando. A diferencia de
  // INVALID_ORDER, el valor es sintacticamente valido y lo que falla es su
  // relacion con el recurso: mismo caso que COLUMN_NOT_IN_BOARD, que la 6.4 pone
  // en 409.
  INVALID_REASSIGN_TARGET: 409,
  DUPLICATE_KEY: 409,
  /**
   * --- 413 ---------------------------------------------------------------
   *
   * El tope de 256 KB por cuerpo de la 7.3. La 6.4 no lo lista, y eso no lo
   * convierte en un codigo inventado: el catalogo se amplia cuando aparece el
   * caso, igual que paso con los siete de forma y con RATE_LIMITED. 413 y no 400
   * porque es la semantica exacta —el cuerpo es valido, es demasiado grande— y
   * porque un 400 le diria a un cliente que revise lo que mando cuando lo que
   * tiene que revisar es cuanto mando.
   *
   * Es un codigo del BORDE, como UNAUTHENTICATED o RATE_LIMITED: el nucleo no
   * lo produce, porque no sabe que existen las peticiones, y mucho menos cuanto
   * pesan. Aun asi ESTA en `DomainErrorCode` desde el paso 11 de F4, igual que
   * esos dos y FORBIDDEN_SCOPE: `HttpPort` lo recibe en la envoltura de la 6.4 y
   * lo reconstruye como error de dominio (ver `CODIGOS_DE_DOMINIO` en
   * `packages/core/src/domain/errors.ts`).
   */
  PAYLOAD_TOO_LARGE: 413,

  // --- 422 y para arriba -------------------------------------------------
  IDEMPOTENCY_MISMATCH: 422,
  CONFIRMATION_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type CodigoDeError = keyof typeof ESTADO_POR_CODIGO;
