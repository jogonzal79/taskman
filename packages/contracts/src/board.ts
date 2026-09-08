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

/**
 * Una columna en el borde HTTP, con cuantas tareas tiene.
 *
 * `position` es el orden denso 0..n-1 dentro del tablero y `task_count` no
 * puede ser negativo: los dos son `int()` y no `number()` porque un decimal ahi
 * seria un bug nuestro, y esta forma tambien valida la SALIDA.
 */
export const columnaDetallada = z.strictObject({
  id: z.uuid(),
  board_id: z.uuid(),
  name: z.string(),
  key: z.string(),
  position: z.int().min(0),
  task_count: z.int().min(0),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type ColumnaDetallada = z.infer<typeof columnaDetallada>;

/** Respuesta de GET /api/boards/{id} (6.2): tablero, columnas y recuentos. */
export const tableroDetallado = z.strictObject({
  ...tablero.shape,
  columns: z.array(columnaDetallada),
  // El total del tablero. Va aparte y no se deja calcular al cliente porque el
  // cliente solo puede sumar lo que ve, y esta respuesta no trae las tareas.
  task_count: z.int().min(0),
});

export type TableroDetallado = z.infer<typeof tableroDetallado>;

/**
 * El `{id}` de las rutas /api/boards/{id}.
 *
 * Vive aca y no en el Route Handler por ADR-006 —los esquemas son una sola
 * definicion— y ademas porque `apps/web` no declara zod: los contratos llegan
 * ya construidos desde este paquete, que es lo que evita que el adaptador tenga
 * que resolver la dependencia por su cuenta.
 *
 * Validar el id ANTES de consultar es lo que separa un 400 de un 500: un id que
 * no es UUID llega a PostgreSQL como texto y vuelve como un 22P02 del driver,
 * indistinguible de un fallo real.
 */
export const parametrosDeTablero = z.object({ id: z.uuid() });

export type ParametrosDeTablero = z.infer<typeof parametrosDeTablero>;
