import { z } from "zod";

import { listadoDe } from "./pagination.js";

/**
 * Un tablero tal como viaja por HTTP. Las convenciones son las de la 6.1:
 * snake_case en el borde —adentro el nucleo los tiene en camelCase— y fechas
 * ISO 8601 con zona horaria en `created_at` y `updated_at`.
 *
 * La traduccion entre una forma y la otra ocurre en el adaptador, no aca y
 * tampoco en el nucleo.
 *
 * `strictObject` y no `object`: un campo de mas tiene que ser un error y no
 * pasar callado. Esta misma forma se usa para validar la SALIDA antes de
 * responder, asi que lo que atrapa no son entradas maliciosas sino filtraciones
 * nuestras, del tipo de un campo interno que se cuela en la respuesta.
 */
export const tablero = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type Tablero = z.infer<typeof tablero>;

/** Respuesta de GET /api/boards (6.2). */
export const listadoDeTableros = listadoDe(tablero);

export type ListadoDeTableros = z.infer<typeof listadoDeTableros>;
