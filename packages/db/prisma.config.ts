import { defineConfig, env } from "prisma/config";

// Prisma 7 ya no lee la URL desde schema.prisma. Los comandos de migracion e
// introspeccion la toman de aca; el cliente en runtime la recibe por el driver
// adapter (ver src/client.ts).
//
// DATABASE_URL la inyecta dotenv-cli desde el .env de la raiz del repo: mira
// los scripts de package.json. `env()` falla ruidosamente si no esta definida.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
