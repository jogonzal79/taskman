import type { NextConfig } from "next";

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
  /**
   * Binarios y runtime de Prisma: se cargan del disco, no se empaquetan.
   *
   * `pino` esta por lo mismo y por una razon propia: resuelve `process.env` y
   * modulos por nombre en tiempo de ejecucion, que es justo lo que un bundler
   * rompe al reescribirlos. OJO con el precedente de `@prisma/client` y `pg`: una
   * entrada aca es INERTE si el paquete no se resuelve desde apps/web, asi que
   * `pino` va tambien en sus dependencies, apuntando a la MISMA copia fisica.
   *
   * `@modelcontextprotocol/sdk` NO ESTA, Y ES A PROPOSITO. Resuelve desde apps/web,
   * asi que la entrada no seria inerte: haria algo, y lo que haria es DUPLICAR ZOD.
   * Node cargaria el SDK con su zod nativa mientras el nucleo sigue usando la
   * empaquetada, y quedan DOS instancias del mismo modulo aunque haya UNA sola
   * copia fisica: el realpath no lo ve. Medido con `next build` + `next start` y
   * una sonda que comparaba con `===` la clase de un esquema construido por el SDK
   * contra `z.ZodObject`: sin declararlo, true; declarado, false. Hoy no rompe nada
   * —las once herramientas se listan y validan igual— y es el mismo riesgo latente
   * que el `instanceof Sql` de Prisma con otro nombre. Empaquetado no necesita
   * configuracion: Turbopack empaqueta el SDK, que es ESM ya compilado, sin
   * `transpilePackages`.
   *
   * Para diagnosticar dos zod, `instanceof` NO SIRVE: en zod 4 compara traits
   * (`inst._zod.traits.has(nombre)`) y da true con dos instancias. Solo `===` sobre
   * la clase lo ve. Si algun dia hiciera falta externalizar el SDK, la salida
   * seria declarar tambien `zod`, y eso NO esta medido.
   */
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "pino"],
};

export default config;
