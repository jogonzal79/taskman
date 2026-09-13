import { z } from "zod";

/**
 * Listados paginados por cursor (6.1): `limit` por defecto 50 y maximo 200,
 * `cursor` opcional, y una respuesta con `items` y `next_cursor`.
 *
 * Los numeros se repiten aca aunque el nucleo ya los tenga (LIMITE_PAGINA_*)
 * porque este paquete es una HOJA del grafo de dependencias (3.3): no importa
 * nada del proyecto, y menos que menos el nucleo. Son el limite del contrato
 * publico, que es lo que documenta la 6.1; que hoy coincidan con los del nucleo
 * no los hace el mismo dato.
 */
export const LIMITE_DEFECTO = 50;
export const LIMITE_MAXIMO = 200;

/**
 * Los parametros llegan del query string, o sea siempre como texto: por eso
 * `coerce`. Ausente no es lo mismo que invalido —`?limit=abc` tiene que ser un
 * 400 y no un silencioso 50—, y `default` solo se aplica cuando falta.
 */
export const consultaDeListado = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(LIMITE_DEFECTO),
  cursor: z.string().min(1).optional(),
});

export type ConsultaDeListado = z.infer<typeof consultaDeListado>;

/**
 * Envoltura de un listado. `next_cursor` es null en la ultima pagina, nunca se
 * omite: un agente que lee la respuesta no tiene que distinguir "no hay mas" de
 * "el campo no vino".
 */
export function listadoDe<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
