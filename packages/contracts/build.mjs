import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Genera openapi.json en la raiz del repo desde los esquemas Zod de este
 * paquete (ADR-006: la generacion es parte del pipeline de compilacion, y el
 * resultado se versiona para revisar los cambios de contrato en el diff).
 *
 * DOS PASOS y no uno porque `src/` es TypeScript con specifiers NodeNext
 * (`./task.js` apunta a `task.ts`): el stripping de tipos nativo de Node NO
 * hace esa sustitucion, asi que `node src/openapi/documento.ts` no resuelve
 * nada. esbuild si la hace sola, igual que en `apps/mcp-stdio`, asi que primero
 * se empaqueta y despues se ejecuta el bundle.
 *
 * El generador del bundle no toca el sistema de archivos: devuelve el documento
 * y el texto, y lo escribe este script. Asi `src/` se mantiene sin `@types/node`
 * —su tsconfig lleva `"types": []`— y sigue siendo contrato puro.
 */
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
const texto = serializarEstable(documentoOpenApi({ version: paquete.version }));

// Sin traducir saltos: el archivo queda en LF en cualquier plataforma, asi que
// dos generaciones dan los mismos bytes tambien en Windows.
writeFileSync(destino, texto, { encoding: "utf8" });

console.log(`[contracts] openapi.json generado (${texto.length} bytes)`);
