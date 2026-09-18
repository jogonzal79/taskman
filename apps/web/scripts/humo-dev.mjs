// Comprobacion de humo del servidor de DESARROLLO.
//
// Uso:  pnpm run humo:dev            (desde la raiz)
//       pnpm --filter @taskman/web run humo:dev
//
// DATABASE_URL y API_KEY_PEPPER las inyecta dotenv-cli desde el .env de la raiz,
// igual que en el resto de los scripts del repo.
//
// POR QUE EXISTE. `next build` y la suite de vitest no ven el servidor de dev, y
// hay una clase entera de fallo que solo vive ahi: Next compila
// `instrumentation.ts` TAMBIEN para el runtime edge, donde no hay `fs` ni valen
// los `serverExternalPackages`. Un import que arrastre `pg` o Prisma hasta ese
// bundle no rompe el build —sin rutas edge Next no lo emite— pero deja `next dev`
// devolviendo 500 en TODA peticion. Eso paso de verdad, entre 2518c5f y 5b1bb9c,
// y sobrevivio cuatro commits con `verify` en verde.
//
// QUE COMPRUEBA, y por que las dos cosas y no una:
//
//   GET /api/health   no lleva `conAuth`, asi que su grafo es el mas chico del
//                     proyecto. Que responda 200 prueba que el proceso arranco y
//                     que `instrumentation.register()` no lo mato.
//   GET /api/boards   autenticada. Pasa por `lib/auth.ts` -> `ApiKeyService` ->
//                     el nucleo -> Prisma, que es el grafo que de verdad se
//                     rompe. Un 200 aca es lo unico que prueba que la ruta
//                     compilo Y que la cadena hasta la base funciona en dev.
//   POST /mcp        tools/list por Streamable HTTP (8.1), con la misma clave.
//                     Es el UNICO camino que mete el SDK de MCP en el bundle de
//                     Next: la suite de vitest invoca el Route Handler directo,
//                     sin Turbopack, y `next build` lo compila pero no lo pide.
//                     Sin esto, un SDK que rompiera `next dev` dejaria `verify`
//                     en verde. No alcanza el 200: exige que el listado traiga
//                     `list_boards`, que es lo que prueba que el SDK monto las
//                     herramientas del nucleo y no que respondio cualquier cosa.
//   GET /            la UI de lectura de la 9.1. Es un Server Component, o sea
//                     que su grafo es el mas grande del proyecto —React, el
//                     nucleo, Prisma— y ademas es el UNICO camino que renderiza:
//                     un fallo al evaluar el componente o al cargar su CSS no lo
//                     ve ninguna otra comprobacion. La suite de vitest importa
//                     Route Handlers y los invoca a mano; nunca renderiza una
//                     pagina, y no hay Playwright todavia.
//
// Health sola no alcanzaria: en el fallo de 2518c5f las DOS daban 500, pero el
// modo de fallo contrario —una ruta con `conAuth` rota y health sana— existe
// igual. La UI de F3 es justamente eso: sin esta comprobacion, `verify` pasa en
// verde con la unica pagina del proyecto devolviendo 500.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const require = createRequire(import.meta.url);

/**
 * Puerto propio, no 3000.
 *
 * El candado de `next dev` es por distDir y lo esquiva TASKMAN_DIST_DIR (ver
 * next.config.ts), pero el puerto es un recurso aparte: si esto usara 3000,
 * cualquier `verify` corrido con el dev del desarrollador abierto fallaria por
 * "address in use". 3987 no es el default de nada conocido.
 */
const PUERTO = Number(process.env["TASKMAN_HUMO_PORT"] ?? 3987);
const BASE = `http://127.0.0.1:${PUERTO}`;
const DIST_DIR = ".next-humo";

/** Etiqueta de la clave efimera. Se borra al terminar, pase lo que pase. */
const ETIQUETA = "humo-dev efimera";

/** Tope para que el servidor conteste ALGO. El fallo que buscamos contesta 500. */
const TIMEOUT_ARRANQUE_MS = 90_000;

let hijo;
let salida = "";
/** DATABASE_URL y si hay clave que borrar, para que `fallar` pueda limpiar. */
let conexion;
let hayClave = false;

function log(mensaje) {
  console.log(`[humo:dev] ${mensaje}`);
}

/**
 * Mata el arbol del servidor POR PID.
 *
 * Nunca un `Stop-Process -Name node` ni nada por el estilo: en esta maquina los
 * servidores MCP de la sesion tambien son `node` y se los llevaria puestos.
 *
 * En Windows hace falta el arbol entero (`/T`): `next dev` es al menos tres
 * procesos encadenados —el bin, el servidor y su worker— y matar solo el que
 * lanzamos deja al que escucha el puerto vivo y huerfano. Medido: matar el bin
 * con /T informa 4 terminaciones y libera el puerto; sin /T, no.
 */
function matarServidor() {
  if (hijo === undefined || hijo.exitCode !== null || hijo.killed) {
    return;
  }

  const pid = hijo.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    // Lanzado con `detached`, asi que el PID negativo es el grupo entero.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ya se habia ido.
    }
  }
}

// Tres caminos de salida, los tres tienen que limpiar: terminar normal, un fallo
// nuestro, y un Ctrl+C. `exit` corre sincrono, que es justo lo que hace spawnSync.
process.on("exit", matarServidor);
for (const senal of ["SIGINT", "SIGTERM"]) {
  process.on(senal, () => {
    matarServidor();
    process.exit(130);
  });
}

/**
 * Imprime el motivo y sale con 1, dejando limpios el proceso Y la clave.
 *
 * Borra la clave TAMBIEN al fallar: si no, una corrida fallida deja una
 * credencial viva en la base hasta la siguiente. La limpieza del arranque la
 * cubriria igual —es idempotente por etiqueta— pero eso es curarse solo, no
 * limpiar.
 */
async function fallar(mensaje) {
  console.error("");
  console.error(`[humo:dev] FALLO: ${mensaje}`);

  if (salida.trim() !== "") {
    console.error("");
    console.error("--- salida de `next dev` ---");
    console.error(salida.trimEnd());
    console.error("--- fin ---");
  }

  matarServidor();

  if (conexion !== undefined && hayClave) {
    // Si esto tambien falla, la limpieza del proximo arranque se encarga.
    await limpiarClaves(conexion).catch(() => {});
  }

  process.exit(1);
}

async function exigirEntorno(nombre) {
  const valor = process.env[nombre];

  if (valor === undefined || valor.trim() === "") {
    await fallar(`${nombre} no esta definida. Copia .env.example a .env en la raiz del repo.`);
  }

  return valor;
}

/** Borra las claves de corridas anteriores y las de esta. Idempotente. */
async function limpiarClaves(connectionString) {
  const cliente = new Client({ connectionString });
  await cliente.connect();

  try {
    await cliente.query("DELETE FROM api_key WHERE label = $1", [ETIQUETA]);
  } finally {
    await cliente.end();
  }
}

/**
 * Emite una clave corriendo el MISMO script que `pnpm run apikey:create`.
 *
 * No se hashea aca a proposito: el hash tiene UNA definicion
 * (`packages/core/src/domain/api-key.ts`) y si este script tuviera la suya, el
 * dia que difirieran emitiria claves que no validan y el sintoma seria un 401
 * indistinguible de una clave mal tipeada. El precio es que esta comprobacion
 * hereda el Node 22.6+ de ese comando (usa el stripping de tipos nativo), por
 * encima del Node 20+ que declara el resto del proyecto.
 *
 * Se invoca por RUTA y con `node`, no por `pnpm --filter`: `npm_execpath` no
 * viene definido, `pnpm` es un `.cmd` en Windows —o sea `shell: true` y comillas
 * que romperia la etiqueta con espacios— y arrancar pnpm cuesta un par de
 * segundos. Es una invocacion de proceso, no un import: no cruza el grafo de
 * modulos ni las reglas de dependencia de la 3.3.
 */
const SCRIPT_DE_CLAVES = fileURLToPath(
  new URL("../../../packages/core/scripts/create-api-key.mjs", import.meta.url),
);

async function emitirClave() {
  const resultado = spawnSync(process.execPath, [SCRIPT_DE_CLAVES, ETIQUETA, "read"], {
    encoding: "utf8",
  });

  const texto = `${resultado.stdout ?? ""}${resultado.stderr ?? ""}`;

  if (resultado.status !== 0) {
    console.error(texto);
    await fallar(`apikey:create salio con estado ${resultado.status}.`);
  }

  // El formato lo fija `prefijoDe` (ADR-005) y el script lo imprime en su propia
  // linea. Si alguna vez cambia, esto falla aca y no con un 401 misterioso.
  const clave = texto.match(/\btmk_live_[A-Za-z0-9]+/u)?.[0];

  if (clave === undefined) {
    console.error(texto);
    await fallar("no se pudo leer la clave de la salida de apikey:create.");
  }

  return clave;
}

async function pedir({ metodo, ruta, clave, cuerpoJson }) {
  const cabeceras = clave === undefined ? {} : { authorization: `Bearer ${clave}` };

  if (cuerpoJson !== undefined) {
    cabeceras["content-type"] = "application/json";
    // Streamable HTTP exige que el cliente acepte las dos formas de respuesta.
    cabeceras["accept"] = "application/json, text/event-stream";
  }

  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: cabeceras,
    ...(cuerpoJson === undefined ? {} : { body: JSON.stringify(cuerpoJson) }),
  });
  const texto = (await respuesta.text()).trimStart();

  // Un fallo de compilacion se sirve como la pagina de error de Next: 4 KB de
  // HTML donde el mensaje util esta enterrado. En ese caso el cuerpo no aporta
  // nada —el error entero sale en la salida de `next dev`, que se imprime
  // debajo— y volcarlo tapa justamente lo que hay que leer.
  const cuerpo = texto.startsWith("<")
    ? "(pagina de error HTML de Next; el motivo esta en la salida de abajo)"
    : texto.slice(0, 300);

  return { estado: respuesta.status, cuerpo, texto };
}

/** El tools/list de /mcp trae `list_boards`: el SDK monto el catalogo del nucleo. */
function listaHerramientas(texto) {
  try {
    const nombres = JSON.parse(texto)?.result?.tools?.map((herramienta) => herramienta.name) ?? [];

    return nombres.includes("list_boards")
      ? undefined
      : `tools/list no trajo list_boards (trajo: ${JSON.stringify(nombres)}).`;
  } catch {
    return "la respuesta no es JSON-RPC.";
  }
}

/** Espera a que el servidor conteste ALGO. Un 500 tambien cuenta: es el fallo. */
async function esperarRespuesta() {
  const limite = Date.now() + TIMEOUT_ARRANQUE_MS;

  while (Date.now() < limite) {
    if (hijo.exitCode !== null) {
      await fallar(`\`next dev\` se cerro solo con estado ${hijo.exitCode} antes de contestar.`);
    }

    try {
      // Da igual con que conteste: lo que se espera aca es que el socket
      // exista. El 200 lo exige la comprobacion de abajo, que es la que sabe
      // que se espera de cada ruta.
      await fetch(`${BASE}/api/health`);

      return;
    } catch {
      await new Promise((listo) => setTimeout(listo, 250));
    }
  }

  await fallar(`\`next dev\` no contesto en ${TIMEOUT_ARRANQUE_MS / 1000} s.`);
}

conexion = await exigirEntorno("DATABASE_URL");
await exigirEntorno("API_KEY_PEPPER");

const arranque = Date.now();

await limpiarClaves(conexion);
const clave = await emitirClave();
hayClave = true;
log(`clave efimera emitida (${clave.slice(0, 15)}...)`);

/**
 * Se lanza `node <bin de next>` y no `pnpm run dev`: un binario menos en la
 * cadena, sin `.cmd` ni shell, y el PID que devuelve `spawn` es el que hay que
 * matar. `detached` solo fuera de Windows, donde habilita matar por grupo.
 */
hijo = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "--port", String(PUERTO)], {
  env: { ...process.env, TASKMAN_DIST_DIR: DIST_DIR },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});

for (const flujo of [hijo.stdout, hijo.stderr]) {
  flujo.setEncoding("utf8");
  flujo.on("data", (trozo) => {
    salida += trozo;
  });
}

hijo.on("error", (error) => void fallar(`no se pudo lanzar \`next dev\`: ${error.message}`));

log(`\`next dev\` (Turbopack) en ${BASE} (distDir ${DIST_DIR}, pid ${hijo.pid})`);

await esperarRespuesta();

// En orden de grafo creciente, para que el primero que falle sea el mas barato de
// diagnosticar: si caen todas, el motivo esta en la de arriba.
const comprobaciones = [
  { metodo: "GET", ruta: "/api/health", clave: undefined, que: "sin autenticacion (6.2)" },
  { metodo: "GET", ruta: "/api/boards", clave, que: "autenticada, scope read (7.2)" },
  {
    metodo: "POST",
    ruta: "/mcp",
    clave,
    cuerpoJson: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    que: "MCP por Streamable HTTP, tools/list (8.1)",
    exigir: listaHerramientas,
  },
  { metodo: "GET", ruta: "/", clave: undefined, que: "la UI de lectura, Server Component (9.1)" },
];

for (const comprobacion of comprobaciones) {
  const { metodo, ruta, que } = comprobacion;
  const { estado, cuerpo, texto } = await pedir(comprobacion);

  if (estado !== 200) {
    await fallar(`${metodo} ${ruta} (${que}) devolvio ${estado}, se esperaba 200.\n  cuerpo: ${cuerpo}`);
  }

  const problema = comprobacion.exigir?.(texto);
  if (problema !== undefined) {
    await fallar(`${metodo} ${ruta} (${que}) respondio 200, pero ${problema}\n  cuerpo: ${cuerpo}`);
  }

  log(`${metodo} ${ruta} -> 200  (${que})`);
}

matarServidor();
await limpiarClaves(conexion);

log(`el servidor de desarrollo responde. ${((Date.now() - arranque) / 1000).toFixed(1)} s`);
