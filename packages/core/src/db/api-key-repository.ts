import { prisma, type PrismaClient } from "@taskman/db";

import { esScope, type Scope } from "../domain/api-key";

/**
 * Lectura de `api_key`. Es lo unico que el nucleo necesita de esa tabla para
 * autenticar: una busqueda por `prefix`.
 *
 * Por que por prefijo y no por hash: el prefijo no es secreto —se guarda en
 * claro justamente para identificar la clave en el log (7.1)—, asi que sirve de
 * indice sin filtrar nada, y deja el hash para compararlo en tiempo constante
 * dentro del proceso. Buscar por hash haria la comparacion en el btree de
 * PostgreSQL, que es exactamente lo que la 7.1 pide no hacer.
 */

export interface ApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  keyHash: string;
  scopes: readonly Scope[];
  /** 7.1 / 6.4: una clave revocada se trata igual que una inexistente. */
  revokedAt: Date | null;
}

/**
 * `cliente` va al final y con el singleton por defecto, igual que en
 * `comprobarConexion`: es lo que permite que un adaptador use esto sin importar
 * `@taskman/db`, que es lo que prohibe la 3.2.
 */
export async function buscarClavePorPrefijo(
  prefix: string,
  cliente: PrismaClient = prisma,
): Promise<ApiKeyRow | null> {
  const fila = await cliente.apiKey.findUnique({ where: { prefix } });

  if (fila === null) {
    return null;
  }

  return {
    id: fila.id,
    label: fila.label,
    prefix: fila.prefix,
    keyHash: fila.keyHash,
    // El enum de la base y el del dominio son el mismo conjunto, pero el filtro
    // no sobra: si alguien agrega un valor a `Scope` en una migracion y no aca,
    // preferimos ignorarlo a propagar un scope que el nucleo no sabe evaluar.
    scopes: fila.scopes.filter(esScope),
    revokedAt: fila.revokedAt,
  };
}
