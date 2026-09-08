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

let cliente: PrismaClient | undefined;

/**
 * Construye el cliente en el PRIMER USO, no al evaluar el modulo.
 *
 * Antes `prisma` se creaba en la propia linea del export, asi que importar este
 * modulo —o cualquiera que lo importe, transitivamente— exigia DATABASE_URL.
 * Cualquier herramienta que cargue un modulo del arbol solo para inspeccionarlo
 * heredaba la explosion: el caso que lo destapo fue el "Collecting page data"
 * de `next build`, que importa cada Route Handler para leer sus exports de
 * configuracion y nunca llega a ejecutar nada.
 *
 * La validacion NO se pierde ni se ablanda: es la misma, con el mismo mensaje,
 * corrida en el primer uso real del cliente.
 *
 * Dos niveles de cache a proposito: `cliente` sostiene el unico por proceso
 * (sin el, en produccion cada acceso construiria uno nuevo), y el global
 * sobrevive al hot reload, que es para lo que ya estaba.
 */
function clienteReal(): PrismaClient {
  if (cliente === undefined) {
    cliente = globalForPrisma.__taskmanPrisma ?? createPrismaClient();

    if (process.env.NODE_ENV !== "production") {
      globalForPrisma.__taskmanPrisma = cliente;
    }
  }

  return cliente;
}

/**
 * Se exporta un proxy y no una funcion `getPrisma()` para que la forma del
 * import no cambie en ningun consumidor: `import { prisma } from "@taskman/db"`
 * sigue igual en core-port.ts, health.ts, los repositorios y los tests.
 *
 * Solo se interceptan `get`, `set` y `has`: las tres implican usar el cliente,
 * asi que construirlo ahi es correcto. Quedan fuera a proposito las trampas que
 * usa la INSPECCION —`getPrototypeOf`, `ownKeys`— porque atenderlas volveria a
 * construir el cliente por mirar el objeto, que es exactamente lo que este
 * cambio saca del medio. El precio es que `prisma instanceof PrismaClient` da
 * false; nadie en el repo lo usa (ni eso ni inspeccionar el objeto), y si algun
 * dia hace falta, la salida es pedir el cliente por una funcion y no ampliar el
 * proxy.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_destino, propiedad) {
    const real = clienteReal();
    const valor: unknown = Reflect.get(real, propiedad, real);

    // Los metodos van atados al cliente real. Sin esto se invocarian con el
    // proxy como `this`, y el primer campo privado que tocaran adentro
    // reventaria: un proxy no es la instancia que declaro esos campos.
    return typeof valor === "function" ? valor.bind(real) : valor;
  },

  set(_destino, propiedad, valor: unknown) {
    return Reflect.set(clienteReal(), propiedad, valor);
  },

  has(_destino, propiedad) {
    return Reflect.has(clienteReal(), propiedad);
  },
});
