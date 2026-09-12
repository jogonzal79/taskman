import { z } from "zod";

/**
 * El contrato de una columna en el borde HTTP (6.1 y 6.2).
 *
 * Vive en su propio modulo y no dentro de `board.ts` porque ya no entra solo por
 * ahi: `tableroDetallado` las embebe, y POST /api/boards/{id}/columns las tiene
 * como entrada y como salida. La dependencia va en un solo sentido —`board.ts`
 * importa de aca, nunca al revés— asi que no hay ciclo.
 */

/**
 * Una columna tal como viaja por HTTP. Sin `task_count`: el recuento NO es un
 * atributo de la columna, es una agregacion que solo pide la vista de tablero.
 * Es la misma separacion que el nucleo ya hace entre `Column` y
 * `ColumnWithTaskCount`, y es lo que permite que POST /api/boards/{id}/columns
 * devuelva el orden final del tablero sin inventar recuentos ni pedirlos en una
 * consulta aparte.
 *
 * `strictObject` y no `object`: un campo de mas tiene que ser un error y no
 * pasar callado. Esta misma forma valida la SALIDA antes de responder, asi que
 * lo que atrapa no son entradas maliciosas sino filtraciones nuestras.
 */
export const columna = z.strictObject({
  id: z.uuid(),
  board_id: z.uuid(),
  name: z.string(),
  /** Estable y en mayusculas: es como los agentes referencian la columna. */
  key: z.string(),
  position: z.int().min(0),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type Columna = z.infer<typeof columna>;

/**
 * Una columna con cuantas tareas tiene, para GET /api/boards/{id} (6.2).
 *
 * `position` es el orden denso 0..n-1 dentro del tablero y `task_count` no puede
 * ser negativo: los dos son `int()` y no `number()` porque un decimal ahi seria
 * un bug nuestro, y esta forma tambien valida la SALIDA.
 */
export const columnaDetallada = z.strictObject({
  ...columna.shape,
  task_count: z.int().min(0),
});

export type ColumnaDetallada = z.infer<typeof columnaDetallada>;

/** Iguales a los VARCHAR de `board_column`. */
export const LIMITE_NOMBRE_COLUMNA = 80;

/**
 * Los limites se cuentan en PUNTOS DE CODIGO y no con `.max()`, que cuenta
 * unidades UTF-16: un nombre de 80 emoji ocupa 160 unidades UTF-16 y 80
 * caracteres para PostgreSQL, que es lo que mide el VARCHAR(80), y tambien lo
 * que mide el nucleo al normalizar.
 */
function puntosDeCodigo(valor: string): number {
  return [...valor].length;
}

/**
 * El nombre visible, el que ve una persona: "En revision".
 *
 * Se valida con la MISMA medida que el nucleo —recortar y contar puntos de
 * codigo— asi que el borde y el dominio no pueden discrepar sobre que nombre
 * entra. Validarlo tambien aca es lo que convierte el caso en un
 * VALIDATION_ERROR con la lista de campos, en vez de un NAME_REQUIRED sin decir
 * cual fallo.
 */
const nombreDeColumna = z
  .string()
  .trim()
  .min(1, { error: "El nombre no puede quedar vacio tras recortar los espacios." })
  .refine((valor) => puntosDeCodigo(valor) <= LIMITE_NOMBRE_COLUMNA, {
    error: `El nombre no puede superar los ${LIMITE_NOMBRE_COLUMNA} caracteres.`,
  });

/**
 * La key, SIN NORMALIZAR y SIN TOPE DE LARGO, y las dos ausencias son
 * deliberadas.
 *
 * Normalizar es del nucleo (5.2: "key unica por tablero, normalizada a
 * mayusculas sin espacios"), y `normalizarColumnKey` es su unica definicion:
 * repetirla aca daria dos, libres de separarse. El borde solo comprueba que haya
 * algo, que es lo unico que puede afirmar sin normalizar.
 *
 * El tope tampoco va, y no por olvido: el nucleo mide los 40 caracteres DESPUES
 * de normalizar, y normalizar cambia el largo en los dos sentidos —una corrida
 * de espacios colapsa en un solo `_`, y `toUpperCase()` puede alargar, que "ß"
 * pasa a "SS"—. Un `.max()` sobre la key CRUDA seria entonces una regla
 * distinta de la del dominio, que rechazaria keys que el nucleo acepta y al
 * revés. El largo lo decide `COLUMN_KEY_TOO_LONG`, que el mapeo de la 6.4 ya
 * traduce a 400.
 */
const keyDeColumna = z
  .string()
  .trim()
  .min(1, { error: "La key no puede quedar vacia tras recortar los espacios." });

/**
 * La posicion destino dentro del tablero: un indice 0-based o el literal "end".
 *
 * `optional()` y sin `default`: omitirla significa "al final", y esa regla es
 * del nucleo (`input.position ?? "end"`), no del borde. Ponerle un `default`
 * aca crearia una segunda definicion del valor por defecto. Un indice mayor que
 * el numero de columnas se ajusta al final en vez de fallar, igual que en
 * `move`.
 */
const posicionDeColumna = z.union([z.int().min(0), z.literal("end")]).optional();

/**
 * Cuerpo de POST /api/boards/{id}/columns (6.2, RF-02).
 *
 * El tablero NO va en el cuerpo: va en la ruta. Al ser `strictObject`, mandar
 * un `board_id` duplicado ahi es un 400 que dice que campo sobra, en vez de dos
 * fuentes para el mismo dato que pueden contradecirse.
 */
export const crearColumna = z.strictObject({
  name: nombreDeColumna,
  key: keyDeColumna,
  position: posicionDeColumna,
});

export type CrearColumna = z.infer<typeof crearColumna>;

/**
 * Respuesta de POST /api/boards/{id}/columns: la columna creada Y todas las
 * columnas del tablero en su orden final.
 *
 * Las dos cosas, y no solo la columna, porque insertar en una position
 * intermedia REESCRIBE la position de las demas: devolver unicamente la columna
 * nueva dejaria al cliente con un orden viejo y sin señal de que cambio. Es la
 * misma decision que ya tomo la herramienta `create_column` del borde MCP para
 * esta operacion, y que las dos puertas de la misma operacion informen su efecto
 * igual importa mas que el par de campos repetidos.
 *
 * Lo que NO va es el tablero en si: este endpoint no toca ninguno de sus
 * campos. Incluirlo repetiria el error que PATCH /api/boards/{id} evita al no
 * devolver columnas —mezclar en una respuesta datos de otro instante que la
 * operacion no modifico— y para eso ya esta GET /api/boards/{id}.
 *
 * Tampoco van los recuentos, por lo mismo: habria que pedirlos DESPUES de la
 * transaccion que inserto, asi que la respuesta mezclaria un orden de un
 * instante con recuentos de otro.
 */
export const columnaCreada = z.strictObject({
  column: columna,
  /** TODAS las del tablero, en el orden que quedo tras insertar. */
  columns: z.array(columna),
});

export type ColumnaCreada = z.infer<typeof columnaCreada>;
