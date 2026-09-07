import { createRequire } from "node:module";

import { build } from "esbuild";

// El .mcp.json de la raiz arranca el servidor con `node .../dist/index.js`, asi
// que hace falta un archivo que Node pueda ejecutar. `@taskman/core` y
// `@taskman/db` publican TypeScript crudo (su `main` es ./src/index.ts), asi
// que se empaquetan dentro del bundle; todo lo que viene de node_modules queda
// externo y lo resuelve Node desde apps/mcp-stdio/node_modules.
//
// Por eso este paquete declara @prisma/client, @prisma/adapter-pg, pg y zod
// aunque su codigo no los importe: son las dependencias de lo que se empaqueta,
// y con pnpm cada paquete solo ve las suyas.
const require = createRequire(import.meta.url);
const pkg = require("./package.json");

const externos = Object.keys(pkg.dependencies).filter((nombre) => !nombre.startsWith("@taskman/"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // El comodin cubre los subcaminos: @prisma/client/runtime/client, etc.
  external: [...externos, ...externos.map((nombre) => `${nombre}/*`)],
  logLevel: "info",
});
