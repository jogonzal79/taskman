// Emite una API key (ADR-005 y 7.1) y la muestra UNA sola vez.
//
// Uso:  pnpm run apikey:create -- [--agent] "Etiqueta de la clave" read write
//       (los scopes van en minuscula, como en el borde HTTP; sin scopes
//        no se emite nada, porque una clave sin scopes no autoriza nada)
//
// --agent rotula la clave como AGENT en la auditoria de la 7.4, en vez del API
// por defecto. Es lo que hace que lo que entre por el HttpPort de la 8.1 en
// modo http audite como agente: el borde REST no puede ver por donde entro una
// peticion —HttpPort y curl mandan la misma— asi que el rotulo va en la
// CREDENCIAL, que la elige quien emite. Sin la bandera, API, que es lo que
// audita hoy cualquier clave y por lo tanto lo que no cambia nada.
//
// Va como bandera y no como argumento posicional porque los scopes son
// variadicos: no hay hueco donde meter uno mas. Y como bandera SIN valor
// (`--agent`) y no `--actor agent|api` porque la base solo admite esos dos
// valores (`api_key_actor_type_no_user`) y uno es el default, asi que el valor
// explicito seria siempre redundante.
//
// DATABASE_URL y API_KEY_PEPPER las inyecta dotenv-cli desde el .env de la
// raiz del repo.
//
// OJO con el import de abajo: `../src/domain/api-key.ts` se importa por ruta y
// con extension .ts, y lo ejecuta el stripping de tipos nativo de Node (22.6+).
// Funciona porque ese modulo no importa nada del resto del nucleo: los imports
// relativos del nucleo van SIN extension (./x apunta a x.ts) y el ESM de Node
// exige el specifier completo, asi que un solo import interno alli romperia
// este script. La alternativa, si algun dia hace falta, es empaquetarlo con
// esbuild como hace apps/mcp-stdio.
//
// Antes el motivo era el CONTRARIO y conviene no confundirlos: los specifiers
// eran NodeNext (./x.js -> x.ts) y lo que Node no hacia era esa SUSTITUCION.
// Se dejaron sin extension para que Turbopack pueda resolverlos, porque no
// implementa `extensionAlias`. La regla sobrevive igual, por la razon opuesta.
//
// Se comparte a proposito en vez de recalcular el hash aca: si el script y el
// verificador difirieran, emitiria claves que no validan.

import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { generarClave, hashearClave, prefijoDe } from "../src/domain/api-key.ts";

const SCOPES_VALIDOS = new Set(["read", "write", "delete"]);

const BANDERA_AGENTE = "--agent";

function salir(mensaje) {
  console.error(mensaje);
  process.exit(1);
}

// El `--` separador puede llegar como argumento literal: el script de la raiz
// delega en `pnpm --filter`, y esa segunda pasada lo reenvia tal cual en vez de
// consumirlo. Se descarta aca para que las dos formas de invocacion —desde la
// raiz y desde el paquete— acepten los mismos argumentos.
const crudos = process.argv.slice(2).filter((arg, indice) => !(indice === 0 && arg === "--"));

// Las banderas se separan de lo posicional en vez de leerse por posicion: asi
// `--agent` puede ir antes o despues de la etiqueta, que es la unica forma de
// que convivan con unos scopes variadicos.
const banderas = crudos.filter((arg) => arg.startsWith("--"));
const argumentos = crudos.filter((arg) => !arg.startsWith("--"));

// Una bandera que no reconocemos se RECHAZA en vez de caer en lo posicional. Sin
// esto, un `--agnet` mal tipeado se convierte en la etiqueta de la clave y el
// error que sale habla de scopes desconocidos, o sea de otra cosa: se emitiria
// una clave llamada "--agnet" rotulada API, que es justo lo que se queria
// evitar, y en silencio. Es el mismo criterio con el que el borde REST rechaza
// un parametro de consulta desconocido (6.4) en vez de descartarlo.
const desconocidas = banderas.filter((bandera) => bandera !== BANDERA_AGENTE);
if (desconocidas.length > 0) {
  salir(
    `Banderas desconocidas: ${desconocidas.join(", ")}. La unica es ${BANDERA_AGENTE}.
` +
      'Uso: pnpm run apikey:create -- [--agent] "Mi clave" read write',
  );
}

// El rotulo de actor de la 7.4. Sin bandera, API: es lo que audita hoy toda
// clave, asi que omitirla no cambia nada.
const actorType = banderas.includes(BANDERA_AGENTE) ? "AGENT" : "API";

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
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, actor_type)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], $6::"ActorType")`,
    // El UUID lo genera la aplicacion, no la base (invariante del proyecto).
    [
      randomUUID(),
      label.trim(),
      prefijoDe(clave),
      hashearClave(clave, pepper),
      scopes,
      actorType,
    ],
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
// Se imprime SIEMPRE, tambien cuando es el valor por defecto: es lo que queda
// escrito en `audit_log` por cada escritura que haga esta clave, y enterarse
// meses despues de que una clave rotula distinto de lo que se creia es
// exactamente el trabajo que este renglon ahorra.
console.log(`  actor    : ${actorType}`);
console.log("");
