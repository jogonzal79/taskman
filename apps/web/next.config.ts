import type { NextConfig } from "next";

/**
 * `@taskman/core` y `@taskman/db` publican TypeScript crudo (su `main` es
 * ./src/index.ts, lo mismo que ve build.mjs de apps/mcp-stdio), asi que Next
 * tiene que compilarlos el mismo: sin esto el server bundle intenta cargar .ts.
 *
 * `@taskman/db` esta en la lista aunque apps/web no lo importe: entra igual por
 * `@taskman/core`, y lo que Next mira es la ruta del modulo, no quien lo pidio.
 */
const config: NextConfig = {
  /**
   * Next 16 escribe un AGENTS.md y un CLAUDE.md dentro de apps/web en el primer
   * arranque. Este repo ya tiene su CLAUDE.md en la raiz, curado a mano y con
   * los invariantes del proyecto: un segundo archivo generado, mas especifico
   * por estar mas abajo en el arbol, competiria con el sin que nadie lo haya
   * escrito. Se apaga.
   */
  agentRules: false,
  /**
   * Normalmente `.next`. Lo mueve `scripts/humo-dev.mjs`, y NO por higiene: el
   * candado de `next dev` se llama `lock` y vive DENTRO del distDir
   * (`setup-dev-bundler.js`: `path.join(distDir, 'lock')`), asi que es POR
   * DIRECTORIO y no por puerto. Sin esto, un `verify` corrido mientras el
   * desarrollador tiene su `next dev` abierto muere con "Another next dev server
   * is already running" aunque el puerto de la comprobacion este libre.
   * Comprobado: un `dev` en 3000 con otro vivo en 3999 sale con estado 1.
   *
   * Efecto colateral querido: la comprobacion nunca reusa la cache del dev del
   * desarrollador, asi que compila en frio y mide siempre lo mismo.
   */
  distDir: process.env["TASKMAN_DIST_DIR"] ?? ".next",
  transpilePackages: ["@taskman/core", "@taskman/db"],
  /**
   * Binarios y runtime de Prisma: se cargan del disco, no se empaquetan.
   *
   * `pino` esta por lo mismo y por una razon propia: resuelve `process.env` y
   * modulos por nombre en tiempo de ejecucion, que es justo lo que un bundler
   * rompe al reescribirlos. OJO con el precedente de `@prisma/client` y `pg`: una
   * entrada aca es INERTE si el paquete no se resuelve desde apps/web, asi que
   * `pino` va tambien en sus dependencies, apuntando a la MISMA copia fisica.
   */
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "pino"],
};

export default config;
