import { Client } from "pg";

/**
 * Lo minimo para correr la suite contra la base local: conectar y vaciar.
 *
 * Es una copia reducida de `packages/core/test/helpers.ts` y no un import
 * cruzado a proposito: los helpers de prueba de un paquete no son parte de su
 * API publica, y hacerlos importables desde otro paquete los convertiria en
 * eso. La guarda de DATABASE_URL SI se copia entera, porque es lo unico que
 * impide que un TRUNCATE caiga sobre una base que no es la de docker compose.
 *
 * La siembra no esta duplicada: estas pruebas crean tableros y tareas por la
 * misma via que usa un agente —los servicios y las herramientas MCP—, que es
 * justamente lo que hay que ejercitar.
 */

const TABLAS = ["task", "board_column", "board", "audit_log"] as const;

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
