import { Prisma } from "@taskman/db";

import { LIMITE_PAGINA_DEFECTO, LIMITE_PAGINA_MAXIMO } from "../domain/types.js";

/**
 * Paginacion keyset compartida por los listados del nucleo.
 *
 * El cursor es opaco para el llamador: lleva el valor de la columna de orden ya
 * en texto y el `id`, que es lo que hace total al orden. Va en texto a
 * proposito, para que el casteo lo haga PostgreSQL y no dependamos de como el
 * driver mapea DATE, timestamptz o un enum en una consulta cruda.
 */

export interface OrdenSql {
  columna: string;
  direccion: "ASC" | "DESC";
  /** Si la columna admite NULL; solo `due_date`, por ahora. */
  admiteNulos: boolean;
  /** Casteo del valor del cursor al comparar. */
  cast: string;
}

export interface Cursor {
  v: string | null;
  id: string;
}

export function codificarCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodificarCursor(cursor: string): Cursor | undefined {
  try {
    const crudo: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof crudo !== "object" || crudo === null) {
      return undefined;
    }
    const { v, id } = crudo as { v?: unknown; id?: unknown };
    if (typeof id !== "string" || !(typeof v === "string" || v === null)) {
      return undefined;
    }
    return { v, id };
  } catch {
    return undefined;
  }
}

/** Predicado keyset: "estrictamente despues del cursor" en el orden pedido. */
export function condicionCursor(orden: OrdenSql, cursor: Cursor): Prisma.Sql {
  const columna = Prisma.raw(orden.columna);
  const valor = Prisma.raw(orden.cast);

  if (cursor.v === null) {
    // Solo pasa con NULLS LAST: ya estamos en el bloque final de nulos.
    return Prisma.sql`(${columna} IS NULL AND id > ${cursor.id}::uuid)`;
  }

  const comparador = orden.direccion === "ASC" ? Prisma.raw(">") : Prisma.raw("<");
  const avanza = Prisma.sql`(
    ${columna} ${comparador} ${cursor.v}${valor}
    OR (${columna} = ${cursor.v}${valor} AND id > ${cursor.id}::uuid)
  )`;

  // Con NULLS LAST los nulos van despues de cualquier valor no nulo.
  return orden.admiteNulos ? Prisma.sql`(${avanza} OR ${columna} IS NULL)` : avanza;
}

export function clausulaOrden(orden: OrdenSql): Prisma.Sql {
  return Prisma.raw(
    `${orden.columna} ${orden.direccion}${orden.admiteNulos ? " NULLS LAST" : ""}, id ASC`,
  );
}

export function normalizarLimite(limite: number | undefined): number {
  if (limite === undefined) {
    return LIMITE_PAGINA_DEFECTO;
  }
  return Math.max(1, Math.min(Math.trunc(limite), LIMITE_PAGINA_MAXIMO));
}

/**
 * Corta la fila extra que se pidio de mas, hidrata la pagina y arma el cursor
 * siguiente. `hidratar` traduce ids a entidades respetando el orden recibido.
 */
export async function paginar<T>(
  filas: ReadonlyArray<{ id: string; orden: string | null }>,
  limite: number,
  hidratar: (ids: readonly string[]) => Promise<T[]>,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const hayMas = filas.length > limite;
  const pagina = hayMas ? filas.slice(0, limite) : [...filas];
  const ultima = pagina.at(-1);

  return {
    items: await hidratar(pagina.map((fila) => fila.id)),
    nextCursor:
      hayMas && ultima !== undefined ? codificarCursor({ v: ultima.orden, id: ultima.id }) : null,
  };
}
