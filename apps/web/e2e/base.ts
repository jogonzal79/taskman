import { randomUUID } from "node:crypto";

import { crearCorePort, type ActorContext, type CorePort } from "@taskman/core";
import { Client } from "pg";

/**
 * LECTURA DIRECTA DE LA BASE para las pruebas de extremo a extremo, y ESCRITURA
 * POR EL NUCLEO desde fuera del navegador.
 *
 * Las dos cosas existen por el mismo motivo y ninguna es un atajo:
 *
 *   - LEER POR SQL es lo unico que comprueba el orden DENSO 0..n-1 del ADR-004.
 *     La pantalla muestra una secuencia de tarjetas, y una secuencia correcta en
 *     pantalla es compatible con positions 0, 1, 3, 7 en la base: el hueco no se
 *     ve, y se paga mucho mas tarde. Con un filtro puesto, ademas, la pantalla
 *     muestra un subconjunto, asi que lo que se ve no puede ni siquiera
 *     describir la columna. Por eso los criterios de este paso piden "por SQL".
 *   - ESCRIBIR POR EL NUCLEO, sin pasar por la pantalla, es lo que permite
 *     montar una OPERACION CONCURRENTE: alguien mas —un agente por MCP, otra
 *     pestana— cambio el tablero mientras esta pantalla seguia mostrando el de
 *     antes. Es la unica forma de provocar de verdad la divergencia que la
 *     reconciliacion de la 9.2 existe para corregir; simularla con un doble
 *     probaria el doble.
 *
 * Va aparte de `semilla.ts` porque aquella ESCRIBE el estado inicial y esto lo
 * INTERROGA y lo perturba: son dos momentos distintos de la misma prueba.
 */

/** El tablero que la pagina muestra en la semilla `principal`. */
export const TABLERO = "1 Tablero sembrado";

/** Una fila de `task` tal como esta en la base. */
export interface FilaDeTarea {
  readonly title: string;
  readonly position: number;
}

async function consultar<T>(sql: string, parametros: readonly unknown[]): Promise<T[]> {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL no esta definida.");
  }

  const cliente = new Client({ connectionString: url });
  await cliente.connect();

  try {
    const { rows } = await cliente.query(sql, [...parametros]);

    return rows as T[];
  } finally {
    await cliente.end();
  }
}

/**
 * El contenido REAL de una columna, por su nombre, ordenado por `position`.
 *
 * Se pide por NOMBRE DE TABLERO y de columna y no por id porque los ids los
 * genera la aplicacion en cada siembra: una prueba que los escribiera no seria
 * determinista. Los nombres si son literales de la semilla (10.3).
 *
 * Devuelve `position` ADEMAS del titulo, y eso es el punto: una lista de titulos
 * en el orden correcto no dice si las positions son 0,1,2 o 0,1,5.
 */
export async function columnaEnLaBase(
  nombreColumna: string,
  tablero: string = TABLERO,
): Promise<FilaDeTarea[]> {
  return consultar<FilaDeTarea>(
    `SELECT t.title, t.position
       FROM task t
       JOIN board_column c ON c.id = t.column_id
       JOIN board b ON b.id = c.board_id
      WHERE b.name = $1 AND c.name = $2
      ORDER BY t.position ASC`,
    [tablero, nombreColumna],
  );
}

/** Solo los titulos, en orden. Para cuando lo que se afirma es la secuencia. */
export async function titulosEnLaBase(
  nombreColumna: string,
  tablero: string = TABLERO,
): Promise<string[]> {
  return (await columnaEnLaBase(nombreColumna, tablero)).map((fila) => fila.title);
}

/**
 * Comprueba que las positions de una columna sean la secuencia DENSA 0..n-1.
 *
 * Es la mitad del criterio que no se ve en pantalla. Devuelve las positions para
 * que el mensaje de un fallo diga cuales eran y no solo que no eran las
 * esperadas.
 */
export function positionsDe(filas: readonly FilaDeTarea[]): number[] {
  return filas.map((fila) => fila.position);
}

/** La secuencia densa que deberia tener una columna de `n` tareas. */
export function densa(n: number): number[] {
  return Array.from({ length: n }, (_, indice) => indice);
}

/** El id de una tarea por su titulo. Para perturbar el tablero desde fuera. */
export async function idDeTarea(titulo: string, tablero: string = TABLERO): Promise<string> {
  const filas = await consultar<{ id: string }>(
    `SELECT t.id
       FROM task t
       JOIN board b ON b.id = t.board_id
      WHERE b.name = $1 AND t.title = $2`,
    [tablero, titulo],
  );

  const fila = filas[0];

  if (fila === undefined || filas.length > 1) {
    throw new Error(`Se esperaba UNA tarea titulada "${titulo}", hay ${filas.length}.`);
  }

  return fila.id;
}

/** El id de una columna por su nombre. Para mover por el nucleo desde fuera. */
export async function idDeColumna(
  nombreColumna: string,
  tablero: string = TABLERO,
): Promise<string> {
  const filas = await consultar<{ id: string }>(
    `SELECT c.id
       FROM board_column c
       JOIN board b ON b.id = c.board_id
      WHERE b.name = $1 AND c.name = $2`,
    [tablero, nombreColumna],
  );

  const fila = filas[0];

  if (fila === undefined) {
    throw new Error(`No hay ninguna columna "${nombreColumna}" en "${tablero}".`);
  }

  return fila.id;
}

// --- Perturbar el tablero desde FUERA de la pantalla -------------------------

/**
 * El puerto del nucleo, uno por proceso, igual que en `semilla.ts`: detras hay
 * un `PrismaClient` y construir uno por prueba abriria un pool por prueba.
 */
let puerto: CorePort | undefined;

function corePort(): CorePort {
  puerto ??= crearCorePort();

  return puerto;
}

/**
 * El actor de estas escrituras es AGENT, no USER, y eso no es decorativo: lo
 * que estas funciones montan es exactamente el caso que la 9.2 nombra —"una
 * operacion concurrente de un agente"— asi que el `audit_log` tiene que poder
 * distinguirlas de lo que hizo la pantalla.
 */
function contextoDeAgente(): ActorContext {
  return { actorType: "AGENT", actorName: "prueba concurrente", requestId: randomUUID() };
}

/**
 * MUEVE UNA TAREA SIN PASAR POR EL NAVEGADOR, como haria un agente por MCP
 * mientras la pantalla esta abierta.
 *
 * La pantalla NO se entera: la pagina es `force-dynamic` pero no consulta sola,
 * asi que sigue mostrando —y sigue calculando sobre— el tablero que cargo. Esa
 * es justamente la divergencia que el punto 3 de la 9.2 existe para corregir, y
 * la unica forma honesta de provocarla.
 */
export async function moverPorElNucleo(
  titulo: string,
  nombreColumnaDestino: string,
  position: number | "end",
): Promise<void> {
  const [taskId, columnId] = await Promise.all([
    idDeTarea(titulo),
    idDeColumna(nombreColumnaDestino),
  ]);

  await corePort().moveTask(taskId, { columnId, position }, contextoDeAgente());
}

/** Borra una tarea sin pasar por el navegador. Para el punto 4 de la 9.2. */
export async function borrarPorElNucleo(titulo: string): Promise<void> {
  await corePort().deleteTask(await idDeTarea(titulo), contextoDeAgente());
}
