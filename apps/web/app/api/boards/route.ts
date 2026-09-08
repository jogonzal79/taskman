import { consultaDeListado, listadoDeTableros, type Tablero } from "@taskman/contracts";
import { crearCorePort, type Board, type ListBoardsQuery } from "@taskman/core";

/**
 * GET /api/boards (6.2): lista tableros, paginado por cursor.
 *
 * Sin autenticacion todavia; la API key llega en el paso siguiente y cubre
 * todos los endpoints de una vez.
 *
 * El adaptador no ve Prisma (3.2): habla con el nucleo por `TaskManagerPort` y
 * su unica responsabilidad es validar la entrada, invocar el servicio y
 * traducir el resultado al protocolo.
 */

// Un listado cacheado devuelve los tableros de otro momento.
export const dynamic = "force-dynamic";

/**
 * A nivel de modulo a proposito. `crearCorePort` solo arma servicios y
 * repositorios; el cliente Prisma que le pasa por dentro es el proxy perezoso,
 * asi que construir esto no toca la base ni exige DATABASE_URL. De eso depende
 * que `next build` pueda importar esta ruta para inspeccionarla.
 */
const taskman = crearCorePort();

/** La traduccion camelCase -> snake_case vive en el adaptador (6.1). */
function aSalida(board: Board): Tablero {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    created_at: board.createdAt.toISOString(),
    updated_at: board.updatedAt.toISOString(),
  };
}

function json(cuerpo: unknown, status: number): Response {
  return Response.json(cuerpo, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const parametros = new URL(request.url).searchParams;

  // `?limit=abc` no puede caer en el default: seria devolver 50 tableros a
  // alguien que pidio otra cosa y no enterarse nunca.
  const consulta = consultaDeListado.safeParse({
    limit: parametros.get("limit") ?? undefined,
    cursor: parametros.get("cursor") ?? undefined,
  });

  if (!consulta.success) {
    // La envoltura es la de la 6.4. Todavia sin `request_id`: llega con la
    // cabecera X-Request-Id, que es el paso siguiente.
    return json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Los parametros de la consulta no superan el esquema.",
          details: { issues: consulta.error.issues },
        },
      },
      400,
    );
  }

  // `cursor` va condicional y no como `cursor: undefined` por
  // exactOptionalPropertyTypes: la propiedad presente en undefined no es lo
  // mismo que ausente.
  const query: ListBoardsQuery = {
    limit: consulta.data.limit,
    ...(consulta.data.cursor === undefined ? {} : { cursor: consulta.data.cursor }),
  };

  const pagina = await taskman.listBoards(query);

  /**
   * Validar la SALIDA no es paranoia sobre datos ajenos: lo que se comprueba es
   * que el adaptador siga cumpliendo el contrato que publica. Si deja de
   * cumplirlo es un bug nuestro, asi que es un 500 y no una respuesta a medias:
   * devolver el cuerpo igual convertiria un error detectado en uno silencioso
   * que rompe al cliente mas lejos.
   */
  const salida = listadoDeTableros.safeParse({
    items: pagina.items.map(aSalida),
    next_cursor: pagina.nextCursor,
  });

  if (!salida.success) {
    console.error("[taskman-web] la respuesta de GET /api/boards no cumple el contrato", salida.error.issues);

    return json(
      { error: { code: "INTERNAL_ERROR", message: "Fallo no controlado." } },
      500,
    );
  }

  return json(salida.data, 200);
}
