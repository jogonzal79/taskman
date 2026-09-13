import { z } from "zod";

import { consultaDeListado, listadoDe } from "./pagination.js";

/**
 * El contrato del registro de auditoria en el borde HTTP (6.2 fila
 * GET /api/audit, 7.4 y 4.1).
 */

/** Las tres entidades de dominio que se auditan (7.4). */
export const TIPOS_DE_ENTIDAD = ["board", "column", "task"] as const;

export const tipoDeEntidad = z.enum(TIPOS_DE_ENTIDAD);

export type TipoDeEntidad = z.infer<typeof tipoDeEntidad>;

/** Los tres origenes de la 7.4: la UI, MCP y el resto de clientes REST. */
export const TIPOS_DE_ACTOR = ["USER", "AGENT", "API"] as const;

export const tipoDeActor = z.enum(TIPOS_DE_ACTOR);

export type TipoDeActor = z.infer<typeof tipoDeActor>;

/**
 * `id` viaja como TEXTO, y es la unica entidad del modelo donde pasa esto.
 *
 * `audit_log.id` es BigInt autoincremental (4.1), a diferencia de los UUID del
 * resto. Dos cosas se rompen si se lo trata como numero:
 *
 *   - `JSON.stringify` LANZA ante un bigint ("Do not know how to serialize a
 *     BigInt"), asi que sin convertir no hay respuesta, hay un 500.
 *   - un `number` de JavaScript es exacto hasta 2^53-1 y un bigint de 64 bits
 *     llega mas lejos. Hoy no nos acercamos, pero publicar `number` codifica en
 *     el contrato un limite que la base no tiene, y el desborde no avisa: el
 *     cliente lee un id redondeado y no se entera.
 *
 * Texto decimal, entonces. La conversion la hace el adaptador; el dominio se
 * queda con el bigint, que es lo que la columna ES.
 */
export const idDeRegistro = z.string().regex(/^\d+$/, {
  error: "El id de un registro de auditoria es un entero en texto.",
});

/**
 * Los payloads de la 7.4: `null`, o un objeto JSON cuya forma DEPENDE de la
 * accion —entidad completa en CREATE y DELETE, solo los campos modificados en
 * UPDATE, `{column_id, position}` en MOVE—.
 *
 * Por eso se publica como objeto libre y no como una union discriminada por
 * `action`: la forma exacta la fija la tabla de la 7.4 para cada combinacion, y
 * escribirla aca crearia una SEGUNDA definicion de esa tabla, libre de
 * separarse de la del nucleo (`domain/audit.ts`) sin que nada lo note. Lo que
 * el contrato SI garantiza es lo que un cliente necesita para no romperse: que
 * es un objeto o es null.
 */
const payloadDeAuditoria = z.record(z.string(), z.unknown()).nullable();

/**
 * Un registro tal como viaja por HTTP: los campos de la 4.1, en snake_case.
 *
 * `before_data` y `after_data` van SIEMPRE, sin recorte ni resumen. Son el
 * contenido del log: un registro que dice que algo cambio sin decir que sirve
 * para saber que paso algo y para nada mas, y la 7.4 los especifica campo por
 * campo justamente para poder reconstruir. El peso maximo hoy es el CREATE de
 * un tablero con sus cuatro columnas, del orden de 1 KB. Si algun dia crecen,
 * la salida es un parametro para pedir la linea de tiempo sin payloads, no
 * recortarlos por defecto y que el log deje de servir.
 */
export const registroDeAuditoria = z.strictObject({
  id: idDeRegistro,
  actor_type: tipoDeActor,
  actor_name: z.string(),
  client_id: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  before_data: payloadDeAuditoria,
  after_data: payloadDeAuditoria,
  request_id: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});

export type RegistroDeAuditoria = z.infer<typeof registroDeAuditoria>;

/**
 * Query string de GET /api/audit (6.2, RF-10).
 *
 * LOS FILTROS SON LOS QUE LOS INDICES SOSTIENEN, y la lista corta es el punto:
 * `audit_log` tiene `(entity_type, entity_id, created_at)` y `(created_at)`
 * (4.1), asi que se puede filtrar por entidad y por rango de fecha sin recorrer
 * la tabla. No hay filtro por `action`, `actor_type`, `actor_name`, `client_id`
 * ni `request_id`: ninguno tiene indice, y esta es la tabla que crece con CADA
 * escritura del sistema, o sea en la que un seq scan empeora solo. El que mas
 * se va a extra~nar es `request_id` —correlacionar una respuesta con lo que
 * escribio es el uso mas natural del log— y por eso queda anotado como deuda:
 * el arreglo es un indice nuevo en una migracion aditiva, su propio paso.
 *
 * `entity_id` SIN `entity_type` es un 400 y no un filtro que funciona lento:
 * `entity_id` no es prefijo del indice compuesto, asi que esa consulta seria
 * justamente el seq scan que el resto de la lista evita. Al reves si vale:
 * `entity_type` solo es prefijo y esta servido.
 *
 * El rango es EXCLUSIVO en las dos puntas, igual que el `due_before` /
 * `due_after` de la 6.3.2: un solo criterio para los dos listados con rango,
 * en vez de que cada uno elija.
 */
export const consultaDeAuditoria = z
  .strictObject({
    ...consultaDeListado.shape,
    entity_type: tipoDeEntidad.optional(),
    entity_id: z.string().trim().min(1).optional(),
    created_after: z.iso.datetime({ offset: true }).optional(),
    created_before: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((consulta) => consulta.entity_id === undefined || consulta.entity_type !== undefined, {
    error:
      "Indica entity_type junto a entity_id: sin el, la consulta no puede usar el indice y recorreria la tabla entera.",
    path: ["entity_type"],
  });

export type ConsultaDeAuditoria = z.infer<typeof consultaDeAuditoria>;

/** Respuesta de GET /api/audit: la misma envoltura paginada que el resto. */
export const listadoDeAuditoria = listadoDe(registroDeAuditoria);

export type ListadoDeAuditoria = z.infer<typeof listadoDeAuditoria>;
