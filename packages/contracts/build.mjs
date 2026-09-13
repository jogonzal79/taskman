import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * openapi.json en la raiz del repo, desde los esquemas Zod de este paquete
 * (ADR-006: la generacion es parte del pipeline de compilacion y el resultado se
 * versiona para revisar los cambios de contrato en el diff).
 *
 * DOS MODOS, y NINGUNO por defecto:
 *
 *   --check   Genera en memoria y COMPARA con el archivo versionado. Falla si
 *             difieren. Es lo que corre el script `build`, y por ahi verify.
 *   --write   Escribe el archivo. Es lo que corre `pnpm run openapi:generate`.
 *
 * Que el modo sea obligatorio no es ceremonia. Verify comprueba en vez de
 * regenerar justamente porque regenerar ESCONDE el desfase: sobreescribe el
 * archivo y sigue en verde, y en local lo unico que lo delata es un `git status`
 * sucio despues de un verde, mientras en CI no lo delata nada. Si el modo de
 * escritura fuera el de por defecto, un llamador futuro que olvidara la bandera
 * volveria a esconderlo, en silencio y sin que ninguna prueba cambie de color.
 * Sin defecto, ese olvido es un fallo con mensaje de uso.
 *
 * El bundle es obligatorio en los dos modos porque `src/` es TypeScript y sus
 * imports relativos van SIN extension (`./task` apunta a `task.ts`). El ESM de
 * Node exige el specifier completo, asi que ni con el stripping de tipos nativo
 * resolveria `node src/openapi/documento.ts`; esbuild si, que prueba `.ts` sola.
 *
 * Antes el motivo era el contrario y conviene no confundirlos: los specifiers
 * eran NodeNext (`./task.js` -> `task.ts`) y lo que Node no hacia era esa
 * SUSTITUCION. Se dejaron sin extension para que Turbopack pueda resolverlos,
 * porque no implementa `extensionAlias`. El bundle hace falta igual, por otra
 * razon, y por eso este archivo no cambio.
 *
 * El generador del bundle no toca el sistema de archivos: devuelve el documento y
 * el texto, y lo lee o lo escribe este script. Asi `src/` se mantiene sin
 * `@types/node` —su tsconfig lleva `"types": []`— y sigue siendo contrato puro.
 */
const COMANDO_DE_ESCRITURA = "pnpm run openapi:generate";
const MODOS = new Set(["--check", "--write"]);

const argumentos = process.argv.slice(2);
const modo = argumentos[0];

if (argumentos.length !== 1 || !MODOS.has(modo)) {
  console.error(
    [
      "Uso: node build.mjs (--check | --write)",
      "",
      "  --check   compara openapi.json con lo que generan los esquemas y falla si difieren",
      "  --write   reescribe openapi.json",
      "",
      "El modo es obligatorio: sin el, un llamador que quiso comprobar habria",
      "reescrito el archivo versionado y el desfase se habria ido en silencio.",
    ].join("\n"),
  );
  process.exit(2);
}

const aqui = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const paquete = require("./package.json");
const bundle = join(aqui, "dist", "openapi.mjs");
const destino = join(aqui, "..", "..", "openapi.json");

await build({
  entryPoints: [join(aqui, "src", "openapi", "documento.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Lo resuelve Node desde packages/contracts/node_modules al importar el
  // bundle. Es la MISMA copia de Zod con la que validan los handlers.
  external: ["zod"],
  logLevel: "warning",
});

const { documentoOpenApi, serializarEstable } = await import(pathToFileURL(bundle).href);

// `info.version` sale del package.json de este paquete y no de una constante
// aparte, por lo mismo que la VERSION de /api/health sale del de apps/web: para
// que no puedan separarse. Lo que este documento describe es el contrato, y el
// contrato es este paquete.
const esperado = serializarEstable(documentoOpenApi({ version: paquete.version }));

if (modo === "--write") {
  // Sin traducir saltos: el archivo queda en LF en cualquier plataforma, asi que
  // dos generaciones dan los mismos bytes tambien en Windows.
  writeFileSync(destino, esperado, { encoding: "utf8" });
  console.log(`[contracts] openapi.json generado (${esperado.length} bytes)`);
  process.exit(0);
}

let enDisco;

try {
  enDisco = readFileSync(destino, { encoding: "utf8" });
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }

  console.error(
    [
      "[contracts] openapi.json NO EXISTE, y esta versionado en el repo (ADR-006).",
      "",
      `Generalo con:    ${COMANDO_DE_ESCRITURA}`,
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * La comparacion es del CONTENIDO, no de los bytes crudos, y la unica diferencia
 * entre las dos son los saltos de linea.
 *
 * Con `core.autocrlf=true` —lo que hay en la maquina de desarrollo— un clon
 * fresco deja el archivo en CRLF en disco, mientras el generador siempre emite
 * LF. Comparar bytes crudos daria un fallo INMEDIATO despues de clonar, con el
 * contrato perfectamente al dia, y mandaria a buscar un desfase que no existe.
 * Lo que importa es lo que git va a guardar, y git normaliza las dos formas al
 * mismo blob: por eso el archivo se normaliza antes de comparar. El corolario es
 * que convertir el archivo entero a CRLF no rompe el check, y no deberia: para
 * git ese archivo no cambio.
 */
function normalizar(texto) {
  return texto.replaceAll("\r\n", "\n");
}

const actual = normalizar(enDisco);

if (actual === esperado) {
  console.log(`[contracts] openapi.json al dia (${esperado.length} bytes, sin reescribir)`);
  process.exit(0);
}

/**
 * Que se muestra del diff y por que: el PRIMER punto de divergencia, y nada mas.
 *
 * El documento tiene ~3100 lineas y 94 KB, asi que imprimirlo es inservible. Y un
 * recuento de "lineas que difieren" seria algo peor que inservible, seria
 * engañoso: un campo nuevo en un esquema INSERTA lineas y corre todo lo que
 * sigue, asi que la comparacion por posicion marcaria miles de diferencias para
 * un cambio de tres. El primer punto de divergencia, en cambio, es exactamente
 * donde empieza el cambio real en los dos casos —el campo agregado y el byte
 * editado a mano— y cabe en dos lineas.
 *
 * El diff de verdad lo da git despues de regenerar, que es donde se revisa el
 * contrato, y a eso apunta el mensaje.
 */
function primeraDivergencia(a, b) {
  const lineasA = a.split("\n");
  const lineasB = b.split("\n");

  for (let indice = 0; indice < Math.max(lineasA.length, lineasB.length); indice += 1) {
    if (lineasA[indice] !== lineasB[indice]) {
      return { numero: indice + 1, versionado: lineasA[indice], generado: lineasB[indice] };
    }
  }

  // Inalcanzable: los textos difieren, asi que alguna linea difiere.
  return undefined;
}

function recortar(linea) {
  if (linea === undefined) {
    return "(el archivo termina aca)";
  }

  const limpia = linea.trim();

  return limpia.length > 120 ? `${limpia.slice(0, 120)}...` : limpia;
}

// Cuenta saltos y no elementos del split: el documento termina en salto, asi que
// el split deja un ultimo elemento vacio y el numero no coincidiria con `wc -l`.
// Un mensaje de fallo que discute con `wc -l` invita a dudar del mensaje.
function cuenta(texto) {
  const lineas = texto.split("\n").length - (texto.endsWith("\n") ? 1 : 0);

  return `${lineas} lineas, ${texto.length} bytes`;
}

const divergencia = primeraDivergencia(actual, esperado);

console.error(
  [
    "[contracts] openapi.json NO ESTA AL DIA: los esquemas Zod generan otra cosa.",
    "",
    `  versionado en el repo:  ${cuenta(actual)}`,
    `  generado por los esquemas: ${cuenta(esperado)}`,
    `  primera divergencia: linea ${divergencia.numero}`,
    "",
    `    versionado: ${recortar(divergencia.versionado)}`,
    `    generado:   ${recortar(divergencia.generado)}`,
    "",
    `Corregilo con:   ${COMANDO_DE_ESCRITURA}`,
    "",
    "y despues revisa `git diff -- openapi.json`: ese diff ES la revision del",
    "cambio de contrato (ADR-006), no un efecto secundario del comando. Si no",
    "esperabas ningun cambio, el diff dice de que lado esta el error: el documento",
    "queda diciendo lo que los esquemas dicen HOY, asi que o se toco un esquema",
    "sin querer, o se edito el documento a mano.",
  ].join("\n"),
);

process.exit(1);
