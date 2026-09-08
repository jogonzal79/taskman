-- Tabla de API keys (4.1 / ADR-005). Migracion ADITIVA.
--
-- OJO: `prisma migrate dev` genero ademas estas cuatro sentencias, que se
-- BORRARON a mano de este archivo:
--
--   ALTER TABLE "task" DROP CONSTRAINT "task_column_same_board";
--   DROP INDEX "column_board_pair";
--   DROP INDEX "column_board_position_uniq";
--   DROP INDEX "task_column_position_uniq";
--
-- No son drift real: son las restricciones que, por decision del proyecto,
-- viven SOLO en el SQL crudo de la migracion inicial y no en schema.prisma
-- (las UNIQUE de position tienen que ser DEFERRABLE, y Prisma no sabe
-- expresarlo). Prisma no las ve en el esquema, las toma por sobrantes de la
-- base y propone borrarlas. Aplicarlas se llevaria puestos el orden denso y la
-- FK compuesta que impide que una tarea apunte a la columna de otro tablero.
-- Cualquier migracion futura va a volver a proponerlas: hay que sacarlas
-- siempre a mano.

-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('READ', 'WRITE', 'DELETE');

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(24) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "scopes" "Scope"[] NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_prefix_key" ON "api_key"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- ---------------------------------------------------------------------------
-- SQL crudo: una clave sin scopes no autoriza nada y solo produce 403 que
-- parecen un bug de permisos. Se rechaza en la base.
--
-- El NOT NULL de `scopes` de arriba es parte de ESTA restriccion, no un
-- adorno: un CHECK solo falla cuando la expresion da FALSE, y
-- cardinality(NULL) da NULL, asi que sin el NOT NULL una fila con scopes en
-- NULL pasaria limpio por el CHECK. Que Prisma trate las listas escalares como
-- no-nulables protege al cliente, no a la base.
-- ---------------------------------------------------------------------------
ALTER TABLE api_key
  ADD CONSTRAINT api_key_scopes_nonempty CHECK (cardinality(scopes) > 0);
