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

/**
 * Respuesta de GET /api/boards/{id} y de POST /api/boards (6.2): el tablero,
 * sus columnas y los recuentos.
 *
 * Una sola forma para los dos endpoints a proposito: los dos devuelven "un
 * tablero con sus columnas", y publicar dos formas distintas de la misma cosa
 * obligaria al cliente a mantener dos lectores para el mismo recurso. En la
 * respuesta de POST los recuentos son cero, y no es un relleno: el tablero se
 * acaba de crear con sus columnas en una sola transaccion, asi que ninguna
 * pudo recibir una tarea todavia.
 */
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

/**
 * Los limites del contrato publico para un tablero.
 *
 * Se repiten aca aunque el nucleo ya los tenga (LIMITE_BOARD_NAME y
 * LIMITE_BOARD_DESCRIPTION) por lo mismo que los de `pagination.ts`: este
 * paquete es una HOJA del grafo de dependencias (3.3) y no importa el nucleo.
 * Que hoy coincidan con los suyos no los hace el mismo dato; estos son los que
 * documenta el borde.
 */
export const LIMITE_NOMBRE_TABLERO = 120;
export const LIMITE_DESCRIPCION_TABLERO = 2000;

/**
 * Los limites se cuentan en PUNTOS DE CODIGO y no con `.max()`, que cuenta
 * unidades UTF-16.
 *
 * No es un detalle teorico: un nombre de 120 emoji ocupa 240 unidades UTF-16 y
 * 120 caracteres para PostgreSQL, que es lo que mide el VARCHAR(120) de
 * `board`, y tambien lo que mide el nucleo al normalizar. Con `.max()` el
 * contrato devolveria un 400 por algo que el dominio y la base aceptan sin
 * problema, y el cliente no tendria forma de saber por que.
 */
function puntosDeCodigo(valor: string): number {
  return [...valor].length;
}

/**
 * Los dos campos editables de un tablero, definidos UNA vez.
 *
 * POST y PATCH los envuelven distinto —uno los exige, el otro los hace
 * opcionales— pero la regla de cada campo es la misma, y escribirla dos veces
 * seria dejar que las dos se separen: un limite corregido en el create y
 * olvidado en el update es exactamente el bug que nadie encuentra hasta que un
 * cliente mete por PATCH lo que el POST rechaza.
 *
 * El `trim()` va ANTES de las comprobaciones, asi que un nombre de solo
 * espacios es un nombre vacio y no uno de tres caracteres. El nucleo recorta
 * igual —esta es su regla, no la nuestra—; validarlo tambien aca es lo que
 * convierte el caso en un VALIDATION_ERROR con la lista de campos, en vez de
 * un NAME_REQUIRED sin decir cual fallo.
 */
const nombreDeTablero = z
  .string()
  .trim()
  .min(1, { error: "El nombre no puede quedar vacio tras recortar los espacios." })
  .refine((valor) => puntosDeCodigo(valor) <= LIMITE_NOMBRE_TABLERO, {
    error: `El nombre no puede superar los ${LIMITE_NOMBRE_TABLERO} caracteres.`,
  });

const descripcionDeTablero = z
  .string()
  .trim()
  .refine((valor) => puntosDeCodigo(valor) <= LIMITE_DESCRIPCION_TABLERO, {
    error: `La descripcion no puede superar los ${LIMITE_DESCRIPCION_TABLERO} caracteres.`,
  });

/**
 * Cuerpo de POST /api/boards (6.2).
 *
 * NO acepta `columns`: por la 6.2 este endpoint crea el tablero "con columnas
 * por defecto", que son las cuatro de la 4.3, y para cualquier otra hay un
 * endpoint propio, POST /api/boards/{id}/columns. Al ser `strictObject`,
 * mandarlas no queda ignorado en silencio: es un 400 que dice exactamente que
 * campo sobra.
 *
 * En el create, `description` ausente y `description: null` significan lo
 * mismo —un tablero sin descripcion— y por eso van juntos en `nullish`. En el
 * PATCH no significan lo mismo; ver `actualizarTablero`.
 */
export const crearTablero = z.strictObject({
  name: nombreDeTablero,
  description: descripcionDeTablero.nullish(),
});

export type CrearTablero = z.infer<typeof crearTablero>;

/**
 * Cuerpo de PATCH /api/boards/{id} (6.2): patch parcial de nombre y
 * descripcion.
 *
 * LAS DOS INTENCIONES DE `description`, que es lo que este esquema tiene que
 * poder expresar y por eso se escribe asi:
 *
 *   - AUSENTE: no tocar la descripcion que ya tiene.
 *   - `null`: borrarla.
 *
 * `nullish()` es lo que deja pasar las dos, y no se colapsan porque Zod OMITE
 * la clave de un opcional ausente en lugar de ponerla en undefined. O sea que
 * `"description" in data` distingue una de la otra, y el adaptador lo traduce
 * al `patch.description === undefined` con el que el nucleo decide lo mismo:
 * ausente conserva, presente escribe. Si el esquema pusiera la clave en
 * undefined, las dos intenciones llegarian identicas al nucleo y "borrar la
 * descripcion" seria imposible de pedir.
 *
 * `name` es `optional()` y NO `nullish()`: un tablero sin nombre no existe, asi
 * que `name: null` tiene que ser un 400 y no un borrado.
 *
 * Los dos campos opcionales a la vez permiten el cuerpo vacio `{}`. Es a
 * proposito: un patch sin campos no cambia nada, que es el mismo caso que un
 * patch con el valor que ya estaba, y el nucleo ya trata "sin cambio efectivo"
 * como exito sin registro (5.2). Rechazar uno y aceptar el otro seria una regla
 * del borde que el dominio no tiene.
 */
export const actualizarTablero = z.strictObject({
  name: nombreDeTablero.optional(),
  description: descripcionDeTablero.nullish(),
});

export type ActualizarTablero = z.infer<typeof actualizarTablero>;
