import { randomUUID } from "node:crypto";

import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { ErrorDeApi } from "@taskman/contracts";
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
import { expect } from "vitest";

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
 * `idempotency_record` entra por lo mismo: sus filas sobreviven a la peticion
 * que las creo, asi que una clave usada en una corrida previa haria que la
 * siguiente REPRODUJERA en vez de ejecutar, y el test fallaria por un estado
 * que no sembro. Ademas el CASCADE no la alcanza —no tiene FK a ninguna de las
 * otras— asi que tiene que estar nombrada.
 *
 * La siembra de tableros y tareas NO esta duplicada en SQL crudo: va por el
 * `CorePort`, que es el mismo camino que usan los Route Handlers del otro lado.
 * Los endpoints de columnas y tareas de la 6.2 ya existen, asi que la siembra
 * podria pasar a ellos sin tocar las aserciones; hoy sigue por el `CorePort`.
 */

const TABLAS = [
  "task",
  "board_column",
  "board",
  "audit_log",
  "api_key",
  "idempotency_record",
] as const;

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
  opciones: { label?: string; revocada?: boolean; agente?: boolean } = {},
): Promise<string> {
  const clave = generarClave();

  await client.query(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, revoked_at, actor_type)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], $6, $7::"ActorType")`,
    [
      // El UUID lo genera la aplicacion, no la base (invariante del proyecto).
      randomUUID(),
      opciones.label ?? `clave ${scopes.join("+").toLowerCase()}`,
      prefijoDe(clave),
      hashearClave(clave, PEPPER),
      scopes,
      opciones.revocada === true ? new Date() : null,
      // Lo que hace `--agent` de `apikey:create`. El defecto es API y por eso
      // las decenas de llamadas que no pasan `agente` siguen auditando igual que
      // antes de que la columna existiera: es lo mismo que le pasa a una clave
      // emitida antes de la migracion.
      opciones.agente === true ? "AGENT" : "API",
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
  /**
   * Texto tal cual. Para el cuerpo que NO es JSON, y para los casos donde
   * importa el ORDEN de las claves: `JSON.stringify` conserva el del objeto
   * literal, pero escribir el texto no deja lugar a dudas.
   */
  cuerpoCrudo?: string;
  /** Cabeceras extra, p. ej. la `Idempotency-Key` de la 6.5. */
  cabeceras?: Readonly<Record<string, string>>;
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

  for (const [nombre, valor] of Object.entries(opciones.cabeceras ?? {})) {
    cabeceras.set(nombre, valor);
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

/**
 * Cuerpo de error de la 6.4, derivado del esquema de `packages/contracts`.
 *
 * Era la TERCERA copia de la misma forma —con la de `lib/http.ts` y la del
 * esquema— y la mas facil de olvidar, porque una prueba que lee un campo que ya no
 * existe no falla al compilar si el tipo lo sigue declarando: lee `undefined` y la
 * asercion pasa por otro lado. Derivada, un renombre en el esquema rompe aca.
 */
export type CuerpoDeError = ErrorDeApi;

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

/**
 * Un tablero con las cuatro columnas por defecto de la 4.3.
 *
 * `columns` permite sembrar otro juego de columnas, para los casos que necesitan
 * un tablero donde una key NO exista todavia: con las cuatro por defecto, probar
 * que " todo " normaliza a TODO solo puede dar DUPLICATE_KEY.
 */
export async function sembrarTablero(
  taskman: CorePort,
  args: {
    name: string;
    description?: string | null;
    columns?: ReadonlyArray<{ name: string; key: string }>;
  },
): Promise<BoardDetail> {
  return taskman.createBoard(
    {
      name: args.name,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.columns === undefined ? {} : { columns: args.columns }),
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

// --- Leer el resultado de una herramienta MCP ---------------------------------
//
// Los comparten las dos suites que recorren las once herramientas: la de
// `HttpPort` (http-port.test.ts) y la del transporte /mcp (mcp.test.ts). Vivian
// en la primera; son las mismas, no una copia.

/** Las cuatro de la 4.3, en el orden en que las crea el nucleo. */
export const COLUMNAS_POR_DEFECTO = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE"];

export interface Resultado {
  texto: string;
  json: Record<string, unknown>;
  isError: boolean;
}

/** El bloque JSON de la 8.5 va al final del texto, entre vallas ```json. */
function extraerJson(texto: string): Record<string, unknown> {
  const inicio = texto.indexOf("```json\n");
  const fin = texto.lastIndexOf("\n```");
  if (inicio === -1 || fin <= inicio) {
    throw new Error(`La respuesta no trae bloque JSON:\n${texto}`);
  }
  return JSON.parse(texto.slice(inicio + "```json\n".length, fin)) as Record<string, unknown>;
}

export async function llamarCon(
  cliente: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Resultado> {
  const salida = await cliente.callTool({ name, arguments: args });
  const bloques = salida.content as Array<{ type: string; text?: string }>;

  expect(bloques).toHaveLength(1);
  const texto = bloques[0]?.text ?? "";

  return { texto, json: extraerJson(texto), isError: salida.isError === true };
}

export function ok(resultado: Resultado): Record<string, unknown> {
  expect(resultado.isError, resultado.texto).toBe(false);
  return resultado.json;
}

export function error(resultado: Resultado): Record<string, unknown> {
  expect(resultado.isError, resultado.texto).toBe(true);
  return resultado.json["error"] as Record<string, unknown>;
}

/** El `id` de un objeto del bloque JSON de la 8.5. */
export function idDe(objeto: unknown): string {
  return (objeto as Record<string, unknown>)["id"] as string;
}
