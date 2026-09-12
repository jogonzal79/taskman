import type { Columna } from "@taskman/contracts";
import type { Column } from "@taskman/core";

/**
 * La traduccion camelCase -> snake_case de una columna (6.1).
 *
 * Sale a `lib/` y no se copia en cada Route Handler porque ya son dos los que la
 * necesitan —POST /api/boards/{id}/columns y PATCH /api/columns/{id}— y las dos
 * copias se separarian en el proximo campo que se le agregue a `board_column`.
 * Es el mismo argumento con el que `aTableroSalida` es una sola funcion dentro de
 * su archivo, aplicado ahora entre archivos.
 */
export function aColumnaSalida(columna: Column): Columna {
  return {
    id: columna.id,
    board_id: columna.boardId,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    created_at: columna.createdAt.toISOString(),
    updated_at: columna.updatedAt.toISOString(),
  };
}
