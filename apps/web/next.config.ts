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
  experimental: {
    /**
     * El nucleo esta escrito en el estilo NodeNext que fija tsconfig.base.json:
     * sus imports relativos llevan la extension `.js` aunque el archivo sea
     * `.ts` (`./domain/types.js` -> domain/types.ts). esbuild hace esa
     * sustitucion solo, que es por lo que apps/mcp-stdio no necesita nada; los
     * bundlers de Next no, y sin esto fallan los ~30 imports del barrel.
     *
     * OJO: esta opcion la implementa SOLO webpack. Turbopack la ignora
     * explicitamente (esta en su lista de unsupported), y por eso los scripts
     * de dev y build pasan `--webpack`. Ver la nota en package.json.
     */
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
};

export default config;
