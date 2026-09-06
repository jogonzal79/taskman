// Lista las restricciones de una tabla con su tipo y si son diferibles.
// Uso:  pnpm --filter @taskman/db run constraints [tabla]
//       (por defecto, "task")
//
// DATABASE_URL la inyecta dotenv-cli desde el .env de la raiz del repo.

import { Client } from "pg";

const CONSTRAINT_TYPES = {
  p: "PRIMARY KEY",
  u: "UNIQUE",
  f: "FOREIGN KEY",
  c: "CHECK",
  x: "EXCLUDE",
  t: "TRIGGER",
};

const table = process.argv[2] ?? "task";
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.");
  process.exit(1);
}

const client = new Client({ connectionString });
await client.connect();

try {
  const { rows } = await client.query(
    `SELECT conname                       AS nombre,
            contype                       AS tipo_raw,
            condeferrable                 AS deferrable,
            condeferred                   AS initially_deferred,
            pg_get_constraintdef(oid)     AS definicion
       FROM pg_constraint
      WHERE conrelid = $1::regclass
      ORDER BY contype, conname`,
    [table],
  );

  if (rows.length === 0) {
    console.log(`La tabla "${table}" no tiene restricciones.`);
  } else {
    console.log(`Restricciones de la tabla "${table}":\n`);
    console.table(
      rows.map((row) => ({
        nombre: row.nombre,
        tipo: CONSTRAINT_TYPES[row.tipo_raw] ?? row.tipo_raw,
        deferrable: row.deferrable ? (row.initially_deferred ? "DEFERRABLE INITIALLY DEFERRED" : "DEFERRABLE") : "no",
        definicion: row.definicion,
      })),
    );
  }
} finally {
  await client.end();
}
