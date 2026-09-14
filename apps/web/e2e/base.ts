import { randomUUID } from "node:crypto";

import {
  crearCorePort,
  crearHerramientas,
  generarClave,
  hashearClave,
  prefijoDe,
  type ActorContext,
  type CorePort,
  type McpToolDefinition,
  type Scope,
} from "@taskman/core";
import { CANAL_DE_CAMBIOS } from "@taskman/core/cambios";
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
  /**
   * `due_date` COMO TEXTO `AAAA-MM-DD`, no como `Date`, y eso es la mitad de lo
   * que hace util este campo.
   *
   * `due_date` es una columna DATE y el driver `pg` la convierte a un `Date` de
   * JavaScript anclado a la MEDIANOCHE LOCAL. Con el proceso en UTC-4, leer esa
   * fecha y volver a serializarla en UTC devuelve el DIA SIGUIENTE: la prueba
   * que quiere detectar un corrimiento de un dia lo introduciria ella misma al
   * leer, y entonces no podria distinguir un fallo de su propia lectura.
   * `to_char` en el SQL saca al driver del medio: lo que vuelve es el dia tal
   * como PostgreSQL lo tiene escrito.
   */
  readonly dueDate: string | null;
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
    `SELECT t.title, t.position, to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate"
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
 * Por si sola la pantalla SI se enteraria, por `/eventos` (CT-07). Por eso las
 * pruebas que usan esta funcion para provocar una divergencia cortan antes el
 * flujo (`cortarElFlujoDeCambios`): con el flujo cortado, la pantalla sigue
 * mostrando —y sigue calculando sobre— el tablero que cargo. Esa es justamente la
 * divergencia que el punto 3 de la 9.2 existe para corregir, y la unica forma
 * honesta de provocarla.
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

// --- Los dos caminos AJENOS: MCP y la API REST -------------------------------

/**
 * MUEVE UNA TAREA POR EL REGISTRO DE HERRAMIENTAS MCP (CT-07).
 *
 * Es `moverPorElNucleo` un escalon mas arriba, y la diferencia importa: aquella
 * llama al `CorePort` directamente, y esta pasa por `crearHerramientas` —el
 * registro unico de la 8.1— o sea por el MISMO codigo que ejecuta
 * `apps/mcp-stdio`. Recorre la validacion del esquema de entrada, la resolucion
 * por NOMBRE de la 8.3.1 (por eso los argumentos son titulos y keys, no UUID) y
 * el `contextoDeAgente` que fija `actorType: AGENT` por construccion.
 *
 * LO UNICO QUE NO RECORRE es el transporte stdio, que es lo que el criterio
 * permite explicitamente ("o por el mismo camino del nucleo que usa MCP").
 * Levantar el proceso de `apps/mcp-stdio` dentro de una prueba de navegador
 * agregaria un `esbuild` y un proceso hijo para ejercitar `StdioServerTransport`,
 * que es del SDK y ya tiene su propia suite de contrato en ese paquete.
 */
export async function moverPorMcp(args: {
  tablero?: string;
  tarea: string;
  aColumna: string;
  position: number | "end";
}): Promise<void> {
  const resultado = await herramienta("move_task").handler({
    board: args.tablero ?? TABLERO,
    task: args.tarea,
    to_column: args.aColumna,
    position: args.position,
  });

  // El handler NO lanza: un fallo vuelve como resultado con `isError`, que es lo
  // que ve el agente. Sin esta comprobacion, una prueba con un titulo mal escrito
  // pasaria a medir "la pantalla no cambio" en vez de "el movimiento no llego".
  if (resultado.isError === true) {
    throw new Error(`move_task fallo: ${resultado.content.map((c) => c.text).join(" ")}`);
  }
}

let herramientas: McpToolDefinition[] | undefined;

function herramienta(nombre: string): McpToolDefinition {
  herramientas ??= crearHerramientas(corePort());

  const definicion = herramientas.find((candidata) => candidata.name === nombre);

  if (definicion === undefined) {
    throw new Error(`El registro MCP no tiene la herramienta ${nombre}.`);
  }

  return definicion;
}

/**
 * EMITE UNA API KEY VALIDA CONTRA EL SERVIDOR QUE ESTA CORRIENDO (CT-06).
 *
 * El hash se calcula con el pepper de `process.env.API_KEY_PEPPER`, que es el
 * MISMO que tiene el servidor: los dos procesos los arranca `pnpm run e2e` con
 * `dotenv -e ../../.env`. Si se fijara uno propio —como hace la suite de
 * contrato, que controla los dos lados dentro del mismo proceso— la clave
 * hashearia distinto y el servidor devolveria 401.
 *
 * Se emite DENTRO de la prueba y no a mano porque la siembra de la 10.3 vacia
 * `api_key` antes de cada una.
 */
export async function emitirClaveParaLaApi(scopes: readonly Scope[]): Promise<string> {
  const pepper = process.env["API_KEY_PEPPER"];

  if (pepper === undefined || pepper.trim() === "") {
    throw new Error("API_KEY_PEPPER no esta definida: la clave emitida no validaria.");
  }

  const clave = generarClave();

  await consultar(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, revoked_at)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], NULL)`,
    [randomUUID(), "clave de extremo a extremo", prefijoDe(clave), hashearClave(clave, pepper), scopes],
  );

  return clave;
}

/**
 * CREA UNA TAREA POR LA API REST (CT-06), con una peticion HTTP de verdad contra
 * el servidor que Playwright levanto.
 *
 * Por HTTP y no por el nucleo a proposito: lo que el CT-06 comprueba es que un
 * cambio hecho por OTRO CLIENTE aparezca, y "otro cliente" en la 7.4 es
 * exactamente lo que produce `actor_type: API`. Ese valor lo pone `conAuth` al
 * autenticar la clave, asi que solo se obtiene pasando por el borde REST; por el
 * nucleo habria que fabricar el `ActorContext` a mano y la prueba estaria
 * afirmando sobre un actor que ella misma invento.
 */
export async function crearPorLaApi(args: {
  base: string;
  clave: string;
  boardId: string;
  columnKey: string;
  title: string;
}): Promise<void> {
  const respuesta = await fetch(`${args.base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${args.clave}` },
    body: JSON.stringify({
      board_id: args.boardId,
      column_key: args.columnKey,
      title: args.title,
    }),
  });

  if (respuesta.status !== 201) {
    throw new Error(
      `POST /api/tasks devolvio ${respuesta.status}: ${await respuesta.text()}`,
    );
  }
}

// --- Tableros ------------------------------------------------------------------

/** Una fila de `board_column`: lo que la 4.3 fija por tablero. */
export interface FilaDeColumna {
  readonly key: string;
  readonly name: string;
  readonly position: number;
}

/**
 * Las columnas REALES de un tablero, en orden de `position`, con su key.
 *
 * Es la mitad del CT-01 que la pantalla no puede dar: la pantalla muestra
 * NOMBRES, y la 4.3 fija ademas la KEY de cada columna —la que usan los agentes
 * para resolver referencias— y su position. Un tablero con "Backlog" pintado y
 * key `backlog`, o con las positions 1..4, se veria identico.
 */
export async function columnasDelTableroEnLaBase(tablero: string): Promise<FilaDeColumna[]> {
  return consultar<FilaDeColumna>(
    `SELECT c.key, c.name, c.position
       FROM board_column c
       JOIN board b ON b.id = c.board_id
      WHERE b.name = $1
      ORDER BY c.position ASC`,
    [tablero],
  );
}

/** Los nombres de todos los tableros, en el mismo orden que la barra lateral. */
export async function nombresDeTablerosEnLaBase(): Promise<string[]> {
  const filas = await consultar<{ name: string }>(
    `SELECT name FROM board ORDER BY name::text ASC`,
    [],
  );

  return filas.map((fila) => fila.name);
}

/** Quien escribio un evento de auditoria. */
export interface ActorAuditado {
  readonly actorType: string;
  readonly actorName: string;
}

/**
 * Los CREATE de `audit_log` sobre el tablero con este nombre, con su actor.
 *
 * Existe para afirmar que la creacion desde la pantalla la registra la UI como
 * USER y no otro borde: la Server Action es el unico productor de ese actor
 * (`lib/actor.ts`), asi que un USER aca es que el tablero entro por ella.
 */
export async function creacionesDeTablero(nombre: string): Promise<ActorAuditado[]> {
  return consultar<ActorAuditado>(
    `SELECT a.actor_type::text AS "actorType", a.actor_name AS "actorName"
       FROM audit_log a
       JOIN board b ON a.entity_id = b.id::text
      WHERE a.entity_type = 'board' AND a.action = 'CREATE' AND b.name = $1
      ORDER BY a.id ASC`,
    [nombre],
  );
}

/** El id de un tablero por su nombre. Lo pide el cuerpo de POST /api/tasks. */
export async function idDeTablero(nombre: string = TABLERO): Promise<string> {
  const filas = await consultar<{ id: string }>(`SELECT id FROM board WHERE name = $1`, [nombre]);
  const fila = filas[0];

  if (fila === undefined) {
    throw new Error(`No hay ningun tablero "${nombre}".`);
  }

  return fila.id;
}

// --- La escucha de cambios ---------------------------------------------------

/**
 * CORTA DESDE POSTGRESQL LA CONEXION `LISTEN` DEL SERVIDOR, con
 * `pg_terminate_backend`: lo que le pasa a esa conexion cuando la base se
 * reinicia o alguien la mata a mano. El servidor web y el flujo SSE siguen
 * vivos; lo unico que muere es la escucha, que es justo el caso en el que el
 * latido seguia llegando y el tablero se creia conectado.
 *
 * Se la busca por la SENTENCIA y no por un pid que la prueba no conoce: esa
 * conexion ejecuta `LISTEN` al abrirse y nada mas en toda su vida (ver
 * `lib/cambios.ts`), asi que `pg_stat_activity.query` la nombra mientras exista.
 *
 * Devuelve cuantas corto. Pueden ser mas de una si otro servidor escucha la
 * misma base —un `next dev` abierto—, y a ese le pasa lo mismo que a este: se
 * entera, reconecta y refresca. La prueba exige al menos una, para que "no habia
 * nada que cortar" falle diciendo eso y no otra cosa.
 */
export async function cortarLaEscucha(): Promise<number> {
  const filas = await consultar<{ cortada: boolean }>(
    `SELECT pg_terminate_backend(pid) AS cortada
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND query = $1`,
    [`LISTEN ${CANAL_DE_CAMBIOS}`],
  );

  return filas.filter((fila) => fila.cortada).length;
}
