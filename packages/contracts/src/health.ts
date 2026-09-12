import { z } from "zod";

/**
 * Cuerpo de GET /api/health (6.2, 11.1): conectividad con la base y version
 * desplegada.
 *
 * Estaba escrito como una interfaz de TypeScript DENTRO del Route Handler, asi
 * que era el unico endpoint de la 6.2 cuya respuesta no salia de un esquema: no
 * se validaba al salir y no podia aparecer con `content` en openapi.json, que es
 * lo que la ADR-006 evita. Vive aca como el resto del borde HTTP.
 *
 * DOS esquemas y no uno con uniones adentro, porque son dos respuestas distintas
 * con dos codigos distintos: el 200 SIEMPRE dice `ok` y trae la latencia, y el
 * 503 SIEMPRE dice `degraded` y no la trae. Un solo esquema con `status` de dos
 * valores y `database` como union permitiria las combinaciones que no existen
 * —un 200 degradado, un 503 con latencia— y openapi.json las publicaria como si
 * fueran posibles. Con dos, cada codigo de estado publica exactamente su forma.
 */

/**
 * `latency_ms` es el tiempo de la sonda, no de la peticion, y por eso es un
 * entero: `Date.now()` ya da milisegundos enteros y la resta tambien.
 */
export const salud = z.strictObject({
  status: z.literal("ok"),
  version: z.string().min(1),
  database: z.strictObject({
    ok: z.literal(true),
    latency_ms: z.int().min(0),
  }),
});

export type Salud = z.infer<typeof salud>;

/**
 * El cuerpo degradado NO lleva detalle del fallo, y es una decision de seguridad
 * y no una omision: el mensaje del driver incluye host, puerto, base y usuario de
 * la cadena de conexion, y este es el unico endpoint sin autenticacion (6.2). El
 * detalle va al stderr del proceso, correlacionable por el X-Request-Id que si
 * viaja en la respuesta (6.1).
 */
export const saludDegradada = z.strictObject({
  status: z.literal("degraded"),
  version: z.string().min(1),
  database: z.strictObject({ ok: z.literal(false) }),
});

export type SaludDegradada = z.infer<typeof saludDegradada>;
