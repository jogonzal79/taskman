import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

// Prisma 7 usa el query compiler: la conexion entra por un driver adapter, no
// por la URL de schema.prisma.
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error(
      "DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.",
    );
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Un unico cliente por proceso. En desarrollo lo colgamos de globalThis para
// que el hot reload no abra un pool nuevo en cada recarga.
const globalForPrisma = globalThis as typeof globalThis & {
  __taskmanPrisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.__taskmanPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__taskmanPrisma = prisma;
}
