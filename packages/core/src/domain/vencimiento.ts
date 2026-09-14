/**
 * "Vencida": LA definicion, la misma que la 6.3.2 llama `overdue`.
 *
 * Una tarea esta vencida si tiene fecha limite ANTERIOR A HOY y NO esta en la
 * columna terminal. No depende solo de la fecha: depende tambien de la key de la
 * columna, y esa es la mitad que es facil olvidar al pintarla en una pantalla.
 *
 * POR QUE EXISTE ESTE MODULO. Hasta ahora la regla vivia en UN solo lugar —el
 * `WHERE` de `TaskRepository.listTasks`— porque el unico que preguntaba era el
 * filtro `overdue` del listado. La UI de la 9.3 la necesita por tarea y ya
 * renderizada, o sea sobre objetos en memoria y no sobre una consulta, y ahi no
 * se puede llamar al `WHERE`. Escribirla de nuevo en el componente dejaria dos
 * definiciones libres de separarse: la que filtra y la que pinta la marca,
 * discrepando justo en el caso que nadie mira (la tarea vencida que ya esta en
 * DONE).
 *
 * LO QUE SI SIGUE ESCRITO DOS VECES, y no se puede evitar: la comparacion de
 * fechas. El filtro la resuelve en PostgreSQL (`due_date < CURRENT_DATE`) porque
 * tiene que entrar en un indice, y esto la resuelve en JavaScript porque el dato
 * ya vino. Lo que SI se comparte es la parte que se presta a divergir —cual es la
 * columna terminal y como se la reconoce— y la forma de la regla completa.
 *
 * DOS COSAS QUE TIENEN QUE COINCIDIR PARA QUE LAS DOS DEN LO MISMO:
 *
 *   - La ZONA. `due_date` es DATE, sin hora ni zona, y Prisma la entrega anclada
 *     a la MEDIANOCHE UTC de ese dia (ver `aFechaUtc` en apps/web). Asi que "hoy"
 *     se lee tambien en UTC: `CURRENT_DATE` de PostgreSQL es el dia de la ZONA DE
 *     LA SESION, que en este proyecto es UTC (`SHOW timezone` sobre el contenedor
 *     de docker-compose devuelve UTC). Si algun dia la base corriera en otra
 *     zona, las dos respuestas podrian diferir durante unas horas al dia, y el
 *     arreglo seria fijar la zona de la sesion, no cambiar esto.
 *   - La COMPARACION es por DIA y no por instante. Una tarea que vence HOY no
 *     esta vencida, y por eso se truncan las dos puntas al dia UTC antes de
 *     comparar: usar el instante de `hoy` haria que "vence hoy" se leyera como
 *     vencida a partir de las 00:00:00.001.
 */

/**
 * La key de la columna terminal. Es una KEY y no un nombre: las keys son
 * estables —no estan en `UpdateColumnInput`— y renombrar la columna a "Archivado"
 * no la saca de la regla. Lo cubre una prueba de `apps/web/test/tasks-list.test.ts`.
 */
export const COLUMNA_TERMINAL = "DONE";

/**
 * Se compara en mayusculas, igual que el `upper(key)` del filtro. Hoy
 * `normalizarColumnKey` ya guarda las keys en mayusculas, asi que es defensa y no
 * necesidad; escribirlo sensible a mayusculas seria apostar a esa invariante
 * desde dos lugares en vez de uno.
 */
export function esColumnaTerminal(key: string): boolean {
  return key.toUpperCase() === COLUMNA_TERMINAL;
}

/** El dia UTC de un instante, como numero comparable. */
function diaUtc(fecha: Date): number {
  return Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
}

/**
 * `hoy` se recibe y no se lee de `new Date()` adentro: asi una pantalla entera se
 * pinta contra UN solo instante —no contra uno por tarjeta, que en el cambio de
 * dia daria una lista inconsistente— y las pruebas pueden fijar el dia sin tocar
 * el reloj del proceso.
 */
export function esVencida(
  tarea: { readonly dueDate: Date | null },
  columna: { readonly key: string },
  hoy: Date,
): boolean {
  if (tarea.dueDate === null) {
    return false;
  }

  if (esColumnaTerminal(columna.key)) {
    return false;
  }

  return diaUtc(tarea.dueDate) < diaUtc(hoy);
}
