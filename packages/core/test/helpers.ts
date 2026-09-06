import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { expect } from "vitest";

const ALL_TABLES = ["task", "board_column", "board", "audit_log"] as const;

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
    `TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export function uuid(): string {
  return randomUUID();
}

// --- Siembra -----------------------------------------------------------------
// Con SQL crudo a proposito: lo que estas pruebas ejercitan es el servicio, no
// el camino de escritura de Prisma.

export async function insertBoard(client: Client, name = "Tablero"): Promise<string> {
  const id = uuid();
  await client.query(`INSERT INTO board (id, name) VALUES ($1, $2)`, [id, name]);
  return id;
}

export async function insertColumn(
  client: Client,
  args: { boardId: string; key: string; position: number; id?: string },
): Promise<string> {
  const id = args.id ?? uuid();
  await client.query(
    `INSERT INTO board_column (id, board_id, name, key, position) VALUES ($1, $2, $3, $4, $5)`,
    [id, args.boardId, args.key, args.key, args.position],
  );
  return id;
}

export async function insertTask(
  client: Client,
  args: { boardId: string; columnId: string; title: string; position: number; id?: string },
): Promise<string> {
  const id = args.id ?? uuid();
  await client.query(
    `INSERT INTO task (id, board_id, column_id, title, position) VALUES ($1, $2, $3, $4, $5)`,
    [id, args.boardId, args.columnId, args.title, args.position],
  );
  return id;
}

/** Siembra una columna con `cantidad` tareas en posiciones 0..cantidad-1. */
export async function insertTasks(
  client: Client,
  args: { boardId: string; columnId: string; prefijo: string; cantidad: number },
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < args.cantidad; i += 1) {
    ids.push(
      await insertTask(client, {
        boardId: args.boardId,
        columnId: args.columnId,
        title: `${args.prefijo}-${i}`,
        position: i,
      }),
    );
  }
  return ids;
}

// --- Verificacion ------------------------------------------------------------

export async function leerOrden(client: Client, columnId: string): Promise<string[]> {
  const filas = await client.query<{ id: string }>(
    `SELECT id FROM task WHERE column_id = $1 ORDER BY position`,
    [columnId],
  );
  return filas.rows.map((fila) => fila.id);
}

/**
 * C5: la columna tiene exactamente las posiciones 0..n-1, sin huecos ni
 * duplicados. Se lee de la base, no del valor devuelto por el servicio.
 */
export async function expectColumnaDensa(client: Client, columnId: string): Promise<void> {
  const filas = await client.query<{ position: number }>(
    `SELECT position FROM task WHERE column_id = $1 ORDER BY position`,
    [columnId],
  );
  const posiciones = filas.rows.map((fila) => fila.position);
  expect(posiciones).toEqual(posiciones.map((_, indice) => indice));
}
