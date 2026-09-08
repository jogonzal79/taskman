import { comprobarConexion } from "@taskman/core";

import { VERSION } from "../../../lib/version.js";

/**
 * GET /api/health (6.2): sonda de salud, sin autenticacion. Comprueba
 * conectividad con la base y devuelve la version desplegada (11.1).
 *
 * El adaptador no ve Prisma: llama a `comprobarConexion` del nucleo y solo
 * traduce el resultado al protocolo (3.2). El plazo de la sonda tampoco se
 * maneja aca; vive en el nucleo, que es quien conoce el driver.
 */

// Una sonda de salud cacheada responde por el estado de otro momento, que es
// justo lo que no sirve. `force-dynamic` la saca del cache de Next y el
// no-store del de cualquier proxy que haya delante.
export const dynamic = "force-dynamic";

type EstadoBase = { ok: true; latency_ms: number } | { ok: false };

interface CuerpoSalud {
  status: "ok" | "degraded";
  version: string;
  database: EstadoBase;
}

function respuesta(cuerpo: CuerpoSalud, status: number): Response {
  return Response.json(cuerpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  const inicio = Date.now();

  try {
    await comprobarConexion();
    // Date.now() ya son milisegundos enteros; la resta tambien.
    return respuesta(
      { status: "ok", version: VERSION, database: { ok: true, latency_ms: Date.now() - inicio } },
      200,
    );
  } catch (error: unknown) {
    // El detalle va al stderr del proceso y NUNCA al cuerpo: el mensaje del
    // driver lleva host, puerto, base y usuario de la cadena de conexion, y
    // este endpoint no pide autenticacion.
    console.error("[taskman-web] la sonda a la base fallo", error);

    return respuesta({ status: "degraded", version: VERSION, database: { ok: false } }, 503);
  }
}
