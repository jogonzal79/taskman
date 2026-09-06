-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'AGENT', 'API');

-- CreateTable
CREATE TABLE "board" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_column" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_column_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "column_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "due_date" DATE,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_name" VARCHAR(120) NOT NULL,
    "client_id" VARCHAR(120),
    "action" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "before_data" JSONB,
    "after_data" JSONB,
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "board_column_board_id_position_idx" ON "board_column"("board_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "board_column_board_id_key_key" ON "board_column"("board_id", "key");

-- CreateIndex
CREATE INDEX "task_column_id_position_idx" ON "task"("column_id", "position");

-- CreateIndex
CREATE INDEX "task_board_id_priority_idx" ON "task"("board_id", "priority");

-- CreateIndex
CREATE INDEX "task_board_id_due_date_idx" ON "task"("board_id", "due_date");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_created_at_idx" ON "audit_log"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- AddForeignKey
ALTER TABLE "board_column" ADD CONSTRAINT "board_column_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "board_column"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SQL crudo: restricciones que Prisma no sabe expresar.
--
-- No las muevas a schema.prisma. Las UNIQUE de `position` tienen que ser
-- DEFERRABLE INITIALLY DEFERRED para que un reordenamiento pueda pasar por
-- estados intermedios invalidos dentro de una transaccion; el @@unique de
-- Prisma genera una version no diferible que se pisaria con estas.
-- ---------------------------------------------------------------------------

-- Orden denso 0..n-1 por columna, verificado recien en el COMMIT.
ALTER TABLE task
  ADD CONSTRAINT task_column_position_uniq
  UNIQUE (column_id, position) DEFERRABLE INITIALLY DEFERRED;

-- Idem para el orden de las columnas dentro de un tablero.
ALTER TABLE board_column
  ADD CONSTRAINT column_board_position_uniq
  UNIQUE (board_id, position) DEFERRABLE INITIALLY DEFERRED;

-- Par referenciable por la FK compuesta de abajo.
ALTER TABLE board_column ADD CONSTRAINT column_board_pair UNIQUE (id, board_id);

-- Una tarea no puede apuntar a una columna de otro tablero. ON DELETE NO ACTION
-- (NO RESTRICT): RESTRICT se evalua fila a fila e impediria el borrado en
-- cascada de un tablero; NO ACTION difiere la comprobacion al final de la
-- sentencia, deja pasar la cascada y sigue rechazando el borrado de una
-- columna que todavia tiene tareas.
ALTER TABLE task
  ADD CONSTRAINT task_column_same_board
  FOREIGN KEY (column_id, board_id)
  REFERENCES board_column (id, board_id) ON DELETE NO ACTION;

ALTER TABLE task ADD CONSTRAINT task_position_nonneg CHECK (position >= 0);
-- `title ~ '\S'` = "contiene al menos un caracter no blanco". Cubre toda la
-- clase de whitespace (espacio, tab, salto de linea, etc.) sin enumerarla, que
-- es justo lo que se le escapaba a length(btrim(title)) > 0: btrim sin conjunto
-- de caracteres recorta solo espacios.
ALTER TABLE task ADD CONSTRAINT task_title_not_blank CHECK (title ~ '\S');

-- Busqueda de texto en espaniol sobre titulo + descripcion.
CREATE INDEX task_search_idx ON task
  USING GIN (to_tsvector('spanish', title || ' ' || coalesce(description, '')));
