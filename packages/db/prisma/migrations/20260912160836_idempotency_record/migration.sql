-- Tabla de registros de idempotencia (4.1 / 6.5). Migracion ADITIVA.
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
-- Volvieron a aparecer en ESTA migracion, que no tiene nada que ver con ellas:
-- hay que sacarlas siempre a mano.

-- CreateTable
--
-- LA PK ES COMPUESTA, `(key, client_id)`, y es un DESVIO DECLARADO de la 4.1,
-- que hace PK a `key` sola. Sin el cliente, dos claves de API que elijan el
-- mismo valor de cabecera —"req-1" lo elige cualquiera— comparten fila, y la
-- segunda se lleva de vuelta el cuerpo de respuesta que guardo la primera. El
-- mecanismo de la 6.5 esta pensado para clientes externos y agentes (ADR-005),
-- asi que esa colision no es hipotetica.
--
-- `client_id` es el prefijo publico de la clave y lleva el MISMO tipo que
-- `api_key.prefix`, VARCHAR(24): son el mismo dato visto desde dos tablas.
CREATE TABLE "idempotency_record" (
    "key" VARCHAR(128) NOT NULL,
    "client_id" VARCHAR(24) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("key","client_id")
);

-- CreateIndex
--
-- Para la purga por antiguedad de la 6.5. La purga NO existe todavia y queda
-- anotada como deuda en CLAUDE.md; el indice se crea igual porque es parte de
-- la tabla que declara la 4.1 y agregarlo despues seria otra migracion.
CREATE INDEX "idempotency_record_created_at_idx" ON "idempotency_record"("created_at");

-- ---------------------------------------------------------------------------
-- SQL crudo: `request_hash` es un SHA-256 en hexadecimal en minusculas, y la
-- base lo verifica. No esta en la 4.1; se agrega por lo mismo que el
-- `api_key_scopes_nonempty` de la migracion anterior.
--
-- El motivo concreto es que la columna es CHAR(64), que en PostgreSQL es
-- BLANK-PADDED: un valor mas corto se rellena con espacios al guardarse y
-- compara IGUAL que su forma rellenada, asi que un hash truncado por un bug no
-- daria error ni al escribir ni al comparar —coincidiria con el original— y el
-- sintoma seria una respuesta idempotente devuelta para un cuerpo distinto. El
-- CHECK convierte ese caso silencioso en un rechazo.
--
-- Las MAYUSCULAS tambien se rechazan, y no es exceso de celo: `'A' <> 'a'` para
-- PostgreSQL, asi que dos representaciones del mismo hash serian dos filas
-- distintas y la reproduccion no encontraria la suya. Que exista UNA sola forma
-- valida es lo que hace que la comparacion signifique algo.
-- ---------------------------------------------------------------------------
ALTER TABLE idempotency_record
  ADD CONSTRAINT idempotency_record_hash_hex CHECK (request_hash ~ '^[0-9a-f]{64}$');
