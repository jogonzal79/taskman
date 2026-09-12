import { randomUUID } from "node:crypto";

import {
  crearCorePort,
  generarClave,
  hashearClave,
  prefijoDe,
  type ActorContext,
  type BoardDetail,
  type CorePort,
  type Scope,
} from "@taskman/core";
import { Client } from "pg";

/**
 * Lo que necesita la suite de contrato REST: conectar, vaciar, emitir claves y
 * armar peticiones.
 *
 * Es una copia reducida de `packages/core/test/helpers.ts`, igual que la de
 * `apps/mcp-stdio`, y por el mismo motivo: los helpers de prueba de un paquete
 * no son parte de su API publica, y hacerlos importables desde otro paquete los
 * convertiria en eso. La guarda de DATABASE_URL SI se copia entera, porque es lo
 * unico que impide que un TRUNCATE caiga sobre una base que no es la de docker
 * compose.
 *
 * `api_key` entra en el TRUNCATE —como en core y a diferencia de mcp-stdio—
 * porque esta suite EMITE claves: si no se vaciaran, las de una corrida previa
 * quedarian validas y un test podria pasar con una clave que no emitio.
 *
 * La siembra de tableros y tareas NO esta duplicada en SQL crudo: va por el
 * `CorePort`, que es el mismo camino que usan los Route Handlers del otro lado.
 * Cuando existan los endpoints de columnas y tareas (6.2) la siembra puede pasar
 * a ellos sin tocar las aserciones.
 */

const TABLAS = ["task", "board_column", "board", "audit_log", "api_key"] as const;

/**
 * El pepper de la suite.
 *
 * Se FIJA en process.env en vez de leerse del .env a proposito. `conAuth`
 * construye el `ApiKeyService` por peticion leyendo esa variable (es el borde, no
 * el nucleo: ahi el pepper va inyectado), asi que la suite tiene que controlar
 * los DOS lados —el que hashea al emitir y el que verifica al autenticar— o las
 * claves que emite no validarian. Fijarlo aca ademas hace que la suite no
 * dependa de que el .env de quien la corre tenga un pepper no vacio.
 */
export const PEPPER = "pepper-del-borde-en-pruebas";

process.env["API_KEY_PEPPER"] = PEPPER;

/**
 * La suite hace TRUNCATE. Si DATABASE_URL apunta a algo que no sea la instancia
 * local de docker compose, preferimos romper antes que vaciarla.
 */
function requireLocalDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.");
  }

  const { hostname } = new URL(url);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(
      `La suite de integracion vacia las tablas con TRUNCATE. DATABASE_URL debe apuntar a la base local de docker compose, pero apunta a "${hostname}".`,
    );
  }

  return url;
}

export async function connectDb(): Promise<Client> {
  const client = new Client({ connectionString: requireLocalDatabaseUrl() });
  await client.connect();
  return client;
}

export async function truncateAll(client: Client): Promise<void> {
  await client.query(
    `TRUNCATE TABLE ${TABLAS.map((tabla) => `"${tabla}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export async function contarFilas(
  client: Client,
  tabla: (typeof TABLAS)[number],
): Promise<number> {
  const filas = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${tabla}"`,
  );
  return Number(filas.rows[0]?.count ?? "0");
}

// --- API keys ----------------------------------------------------------------

/**
 * Emite una clave por el mismo camino que `apikey:create`: hash con el pepper de
 * la suite y prefijo en claro. Devuelve la clave EN CLARO, que es lo unico que
 * sirve para armar la cabecera.
 *
 * Las claves se emiten DENTRO de la suite y no a mano: `verify` vacia `api_key`,
 * asi que cualquier clave emitida por fuera desaparece en la corrida siguiente.
 */
export async function emitirClave(
  client: Client,
  scopes: readonly Scope[],
  opciones: { label?: string; revocada?: boolean } = {},
): Promise<string> {
  const clave = generarClave();

  await client.query(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, revoked_at)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], $6)`,
    [
      // El UUID lo genera la aplicacion, no la base (invariante del proyecto).
      randomUUID(),
      opciones.label ?? `clave ${scopes.join("+").toLowerCase()}`,
      prefijoDe(clave),
      hashearClave(clave, PEPPER),
      scopes,
      opciones.revocada === true ? new Date() : null,
    ],
  );

  return clave;
}

// --- Peticiones --------------------------------------------------------------

/**
 * El host es ficticio: ningun servidor escucha. Los handlers solo leen
 * `new URL(request.url).searchParams`, asi que lo unico que hace falta es que la
 * URL sea absoluta.
 */
const ORIGEN = "http://taskman.test";

export interface OpcionesPeticion {
  metodo?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Ruta con su query, p. ej. "/api/boards?limit=2". */
  ruta?: string;
  /** Clave en claro; va como `Authorization: Bearer`. Ausente, no se manda. */
  clave?: string;
  /** Se serializa a JSON. */
  cuerpo?: unknown;
  /** Texto tal cual, para el caso del cuerpo que NO es JSON. */
  cuerpoCrudo?: string;
}

export function peticion(opciones: OpcionesPeticion = {}): Request {
  const metodo = opciones.metodo ?? "GET";
  const cabeceras = new Headers();

  if (opciones.clave !== undefined) {
    cabeceras.set("authorization", `Bearer ${opciones.clave}`);
  }

  const cuerpo =
    opciones.cuerpoCrudo ??
    (opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo));

  if (cuerpo !== undefined) {
    cabeceras.set("content-type", "application/json");
  }

  return new Request(`${ORIGEN}${opciones.ruta ?? "/api/boards"}`, {
    method: metodo,
    headers: cabeceras,
    // Un GET con cuerpo no es construible: solo se pasa si hay algo que pasar.
    ...(cuerpo === undefined ? {} : { body: cuerpo }),
  });
}

/**
 * En Next 16 los parametros de una ruta dinamica llegan como Promise, y el
 * handler hace `await contexto.params`. Se arma igual aca: el segundo argumento
 * es exactamente lo que le pasaria el ruteo.
 */
export function contextoDeRuta(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// --- Lectura de respuestas ---------------------------------------------------

/** Cuerpo de error de la 6.4. */
export interface CuerpoDeError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    hint?: string;
    request_id: string;
  };
}

export async function leerJson<T>(respuesta: Response): Promise<T> {
  return (await respuesta.json()) as T;
}

export function leerError(respuesta: Response): Promise<CuerpoDeError> {
  return leerJson<CuerpoDeError>(respuesta);
}

// --- Siembra por el nucleo ---------------------------------------------------

export function ctx(): ActorContext {
  return { actorType: "API", actorName: "siembra", requestId: randomUUID() };
}

export function port(): CorePort {
  return crearCorePort();
}

/** Un tablero con las cuatro columnas por defecto de la 4.3. */
export async function sembrarTablero(
  taskman: CorePort,
  args: { name: string; description?: string | null },
): Promise<BoardDetail> {
  return taskman.createBoard(
    {
      name: args.name,
      ...(args.description === undefined ? {} : { description: args.description }),
    },
    ctx(),
  );
}

/** `cantidad` tareas al final de la columna `columnKey` del tablero. */
export async function sembrarTareas(
  taskman: CorePort,
  args: { boardId: string; columnKey: string; prefijo: string; cantidad: number },
): Promise<void> {
  for (let i = 0; i < args.cantidad; i += 1) {
    await taskman.createTask(
      { boardId: args.boardId, columnKey: args.columnKey, title: `${args.prefijo}-${i}` },
      ctx(),
    );
  }
}
