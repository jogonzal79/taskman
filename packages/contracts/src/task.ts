import { z } from "zod";

/**
 * El contrato de una tarea en el borde HTTP (6.1, 6.2 y 6.3.1).
 */

/** Las cuatro de la 6.3.1, iguales al enum `Priority` de la base. */
export const PRIORIDADES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const prioridad = z.enum(PRIORIDADES);

export type Prioridad = z.infer<typeof prioridad>;

/** Igual al VARCHAR(200) de `task.title`. */
export const LIMITE_TITULO_TAREA = 200;

function puntosDeCodigo(valor: string): number {
  return [...valor].length;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `due_date` es una fecha SIN HORA, `AAAA-MM-DD` (6.1), a diferencia de
 * `created_at` y `updated_at`, que llevan zona. La columna es DATE.
 *
 * La validacion es un ida y vuelta y no solo la expresion regular, porque el
 * formato correcto no implica fecha existente: `new Date("2026-02-30T00:00:00Z")`
 * NO da invalida, se corre sola al 2 de marzo. Comprobado en este proyecto. Asi
 * que se reconstruye la fecha y se compara con lo que entro: si no coincide, el
 * dia no existia y es un 400 en vez de una tarea que vence tres dias despues de
 * lo que pidio quien llamo.
 *
 * Vale para la ENTRADA y para la SALIDA. En la salida es lo que atrapa una
 * conversion de zona horaria que se cuele: un `2026-09-11T00:00:00.000Z` completo
 * o un dia corrido por el offset del proceso no pasan esta forma.
 */
export const fechaSola = z
  .string()
  .regex(FECHA, { error: "La fecha tiene que ser AAAA-MM-DD, sin hora ni zona." })
  .refine(
    (valor) => {
      const fecha = new Date(`${valor}T00:00:00.000Z`);
      return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
    },
    { error: "La fecha no existe en el calendario." },
  );

/**
 * Una tarea tal como viaja por HTTP: los campos y el orden de la 6.3.1,
 * snake_case en el borde y camelCase adentro.
 *
 * `strictObject` y no `object`: un campo de mas tiene que ser un error y no pasar
 * callado. Esta misma forma valida la SALIDA antes de responder, asi que lo que
 * atrapa no son entradas maliciosas sino filtraciones nuestras.
 */
export const tarea = z.strictObject({
  id: z.uuid(),
  board_id: z.uuid(),
  column_id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  priority: prioridad,
  due_date: fechaSola.nullable(),
  position: z.int().min(0),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type Tarea = z.infer<typeof tarea>;

/**
 * El titulo se valida con la MISMA medida que el nucleo —recortar y contar puntos
 * de codigo— asi que el borde y el dominio no pueden discrepar sobre que titulo
 * entra. Validarlo aca convierte el caso en un VALIDATION_ERROR con la lista de
 * campos, en vez de un TITLE_REQUIRED sin decir cual fallo.
 */
const tituloDeTarea = z
  .string()
  .trim()
  .min(1, { error: "El titulo no puede quedar vacio tras recortar los espacios." })
  .refine((valor) => puntosDeCodigo(valor) <= LIMITE_TITULO_TAREA, {
    error: `El titulo no puede superar los ${LIMITE_TITULO_TAREA} caracteres.`,
  });

/**
 * La descripcion solo se recorta: SIN tope de largo, porque `task.description` es
 * TEXT y el nucleo tampoco le pone uno. Un `.max()` aca seria una regla del borde
 * que el dominio no tiene, y rechazaria descripciones que la base acepta sin
 * problema. (A diferencia de la de un TABLERO, que es VARCHAR(2000) y si lo
 * lleva.)
 */
const descripcionDeTarea = z.string().trim();

/**
 * La posicion destino dentro de la columna: un indice 0-based, el literal "end",
 * o `null`.
 *
 * `null` esta porque la 6.3.1 lo documenta explicitamente —`"position": null  //
 * null => al final de la columna`— y se traduce a ausente en el adaptador, que es
 * como el nucleo lee "al final" (`input.position ?? "end"`). O sea que null,
 * "end" y omitir el campo son el MISMO pedido, y la regla sigue estando definida
 * en un solo lado.
 */
const posicionDeTarea = z.union([z.int().min(0), z.literal("end")]).nullish();

/**
 * Cuerpo de POST /api/tasks (6.3.1).
 *
 * `column_id` O `column_key`, y al menos uno: la 6.3.1 presenta la key como
 * alternativa al id dentro del mismo tablero, para que un agente cree en TODO sin
 * una consulta previa de resolucion. La RESOLUCION no se hace aca —es del nucleo,
 * `resolverColumna`, que tambien implementa el "si vienen ambos gana column_id"
 * de la 6.3.1— pero exigir que venga al menos una SI es del borde: sin esta
 * comprobacion, un cuerpo sin columna llega al nucleo y vuelve como un
 * COLUMN_NOT_FOUND 404, y un 404 es una respuesta enga~nosa para un cuerpo
 * incompleto.
 */
export const crearTarea = z
  .strictObject({
    board_id: z.uuid(),
    column_id: z.uuid().optional(),
    /** Se normaliza en el nucleo, igual que al crear la columna. */
    column_key: z.string().trim().min(1).optional(),
    title: tituloDeTarea,
    description: descripcionDeTarea.nullish(),
    /** Omitida, el nucleo la deja en MEDIUM. */
    priority: prioridad.optional(),
    due_date: fechaSola.nullish(),
    position: posicionDeTarea,
  })
  .refine((cuerpo) => cuerpo.column_id !== undefined || cuerpo.column_key !== undefined, {
    error: "Indica column_id o column_key.",
    path: ["column_id"],
  });

export type CrearTarea = z.infer<typeof crearTarea>;

/**
 * El `{id}` de las rutas /api/tasks/{id}.
 *
 * Aparte del de tablero y del de columna aunque la forma sea la misma: son
 * entidades distintas y el mensaje de error nombra a cada una. Validar el id
 * ANTES de consultar es lo que separa un 400 de un 500: un id que no es UUID
 * llega a PostgreSQL como texto y vuelve como un 22P02 del driver,
 * indistinguible de un fallo real.
 */
export const parametrosDeTarea = z.object({ id: z.uuid() });

export type ParametrosDeTarea = z.infer<typeof parametrosDeTarea>;
