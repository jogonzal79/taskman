import { randomUUID } from "node:crypto";

import { Client, type DatabaseError } from "pg";

/** Tablas en orden de dependencia; el TRUNCATE las vacia todas de una. */
const ALL_TABLES = ["task", "board_column", "board", "audit_log"] as const;

/**
 * La suite hace TRUNCATE. Si alguna vez DATABASE_URL apunta a algo que no sea
 * la instancia local de docker compose, preferimos romper antes que vaciarla.
 */
function requireLocalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.");
  }

  const { hostname } = new URL(url);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);

  if (!localHosts.has(hostname)) {
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
  await client.query(`TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export function uuid(): string {
  return randomUUID();
}

// --- Siembra -----------------------------------------------------------------
// Sembramos con SQL crudo a proposito: lo que estas pruebas verifican es el
// comportamiento de la base, no el mapeo de Prisma.

export async function insertBoard(client: Client, name = "Tablero"): Promise<string> {
  const id = uuid();
  await client.query(`INSERT INTO board (id, name) VALUES ($1, $2)`, [id, name]);
  return id;
}

export async function insertColumn(
  client: Client,
  args: { boardId: string; key: string; position: number; name?: string; id?: string },
): Promise<string> {
  const id = args.id ?? uuid();
  await client.query(
    `INSERT INTO board_column (id, board_id, name, key, position) VALUES ($1, $2, $3, $4, $5)`,
    [id, args.boardId, args.name ?? args.key, args.key, args.position],
  );
  return id;
}

export async function insertTask(
  client: Client,
  args: {
    boardId: string;
    columnId: string;
    title: string;
    position: number;
    description?: string | null;
    id?: string;
  },
): Promise<string> {
  const id = args.id ?? uuid();
  await client.query(
    `INSERT INTO task (id, board_id, column_id, title, description, position)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, args.boardId, args.columnId, args.title, args.description ?? null, args.position],
  );
  return id;
}

// --- Aserciones sobre errores de PostgreSQL ----------------------------------

export interface DbFailure {
  /** SQLSTATE, p. ej. "23505" (unique_violation). */
  code: string;
  /** Nombre de la restriccion que rechazo la operacion, si Postgres lo informa. */
  constraint: string | undefined;
  message: string;
}

/**
 * Ejecuta `run` esperando que PostgreSQL la rechace y devuelve el SQLSTATE y el
 * nombre de la restriccion. Falla si no hubo error, y re-lanza cualquier error
 * que no venga de la base: no queremos dar por buena una restriccion porque el
 * test se rompio por otro motivo.
 */
export async function expectDbFailure(run: () => Promise<unknown>): Promise<DbFailure> {
  try {
    await run();
  } catch (error: unknown) {
    const dbError = error as Partial<DatabaseError>;

    if (typeof dbError.code !== "string") {
      throw error;
    }

    return {
      code: dbError.code,
      constraint: dbError.constraint,
      message: String(dbError.message ?? ""),
    };
  }

  throw new Error("Se esperaba que PostgreSQL rechazara la operacion, pero termino sin error.");
}

export async function countRows(client: Client, table: (typeof ALL_TABLES)[number]): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${table}"`);
  return Number(result.rows[0]?.count ?? "0");
}
