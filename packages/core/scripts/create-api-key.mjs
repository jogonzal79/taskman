// Emite una API key (ADR-005 y 7.1) y la muestra UNA sola vez.
//
// Uso:  pnpm run apikey:create -- "Etiqueta de la clave" read write
//       (los scopes van en minuscula, como en el borde HTTP; sin scopes
//        no se emite nada, porque una clave sin scopes no autoriza nada)
//
// DATABASE_URL y API_KEY_PEPPER las inyecta dotenv-cli desde el .env de la
// raiz del repo.
//
// OJO con el import de abajo: `../src/domain/api-key.ts` se importa por ruta y
// con extension .ts, y lo ejecuta el stripping de tipos nativo de Node (22.6+).
// Funciona porque ese modulo no importa nada del resto del nucleo: Node no
// resuelve los specifiers NodeNext del proyecto (./x.js -> x.ts), asi que un
// solo import interno alli romperia este script. La alternativa, si algun dia
// hace falta, es empaquetarlo con esbuild como hace apps/mcp-stdio.
//
// Se comparte a proposito en vez de recalcular el hash aca: si el script y el
// verificador difirieran, emitiria claves que no validan.

import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { generarClave, hashearClave, prefijoDe } from "../src/domain/api-key.ts";

const SCOPES_VALIDOS = new Set(["read", "write", "delete"]);

function salir(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

// El `--` separador puede llegar como argumento literal: el script de la raiz
// delega en `pnpm --filter`, y esa segunda pasada lo reenvia tal cual en vez de
// consumirlo. Se descarta aca para que las dos formas de invocacion —desde la
// raiz y desde el paquete— acepten los mismos argumentos.
const argumentos = process.argv.slice(2).filter((arg, indice) => !(indice === 0 && arg === "--"));

const [label, ...scopesCrudos] = argumentos;

if (label === undefined || label.trim() === "") {
  salir('Falta la etiqueta. Uso: pnpm run apikey:create -- "Mi clave" read write');
}

if (scopesCrudos.length === 0) {
  salir(
    "Falta al menos un scope (read, write, delete). Una clave sin scopes no autoriza nada y la\n" +
      "base la rechaza con api_key_scopes_nonempty.",
  );
}

const invalidos = scopesCrudos.filter((scope) => !SCOPES_VALIDOS.has(scope.toLowerCase()));
if (invalidos.length > 0) {
  salir(`Scopes desconocidos: ${invalidos.join(", ")}. Los de la 7.2 son read, write y delete.`);
}

// El CLI habla en minuscula como el borde HTTP; la base usa el enum en
// mayuscula. La traduccion ocurre aca, que es el adaptador de este comando.
const scopes = [...new Set(scopesCrudos.map((scope) => scope.toUpperCase()))];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  salir("DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.");
}

const pepper = process.env.API_KEY_PEPPER;
if (!pepper || pepper.trim() === "") {
  salir(
    "API_KEY_PEPPER no esta definida o esta vacia. Sin pepper el hash no protege nada;\n" +
      "generá uno con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  );
}

const clave = generarClave();
const client = new Client({ connectionString });
await client.connect();

try {
  await client.query(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes)
     VALUES ($1, $2, $3, $4, $5::"Scope"[])`,
    // El UUID lo genera la aplicacion, no la base (invariante del proyecto).
    [randomUUID(), label.trim(), prefijoDe(clave), hashearClave(clave, pepper), scopes],
  );
} finally {
  await client.end();
}

// 7.1: la clave completa se muestra una unica vez, aca. No queda en la base ni
// se puede recuperar: si se pierde, se revoca y se emite otra.
console.log("");
console.log("  Clave creada. Se muestra UNA sola vez; guardala ahora.");
console.log("");
console.log(`  ${clave}`);
console.log("");
console.log(`  etiqueta : ${label.trim()}`);
console.log(`  prefijo  : ${prefijoDe(clave)}`);
console.log(`  scopes   : ${scopes.join(", ")}`);
console.log("");
