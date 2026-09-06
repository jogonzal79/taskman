# Especificación Técnica de Desarrollo

Gestor de tareas Kanban con API REST y servidor MCP para agentes de IA

| Campo | Valor |
| --- | --- |
| Versión del documento | 1.0 |
| Estado | Aprobado para desarrollo |
| Documento base | Documento Técnico-Funcional v1.0 — AI Agent Task Management |
| Alcance | MVP (Fases 1 a 5 del roadmap funcional) |
| Fecha | Septiembre 2026 |
| Audiencia | Desarrollo, QA y operación del sistema |

# 1. Propósito y alcance del documento

Este documento traduce el Documento Técnico-Funcional v1.0 en decisiones de implementación cerradas. Donde el documento funcional dice qué debe hacer el sistema, este documento define cómo se construye: topología, contratos exactos, esquema físico de datos, algoritmos, modelo de errores, estrategia de pruebas y plan de entrega.

## 1.1 Qué cubre

- Decisiones de arquitectura cerradas, con su justificación y consecuencias.

- Modelo de datos físico, índices y restricciones de integridad.

- Contrato completo de la API REST y del servidor MCP, incluyendo formatos de error.

- Algoritmos no triviales: ordenamiento de tareas, movimiento transaccional, idempotencia y desambiguación para agentes.

- Estrategia de pruebas por nivel y criterios de aceptación técnicos trazables a los requisitos funcionales RF-01 a RF-10.

- Configuración, despliegue y plan de implementación por fases.

## 1.2 Qué no cubre

- Justificación de negocio, objetivos y alcance funcional: permanecen en el documento base y no se repiten aquí.

- Diseño visual detallado (paleta, tipografías, mockups). Se define únicamente la estructura de componentes y el comportamiento.

- Funcionalidades listadas como evoluciones futuras en la sección 19 del documento base.

## 1.3 Convenciones

Las palabras DEBE, NO DEBE y PUEDE se usan en sentido normativo. DEBE indica un requisito verificable en revisión de código o pruebas; PUEDE indica una opción permitida cuya omisión no bloquea la aceptación. Los identificadores RF-xx corresponden a la sección 8 del documento funcional; los identificadores ADR-xxx, CT-xx y RT-xx se definen en este documento.

# 2. Decisiones de arquitectura

Cada decisión se registra con contexto, decisión, justificación y consecuencias. Estas decisiones son vinculantes para el MVP; cambiarlas requiere revisar las secciones dependientes de este documento.

## 2.1 ADR-001 — Monolito modular sobre Next.js con núcleo independiente del framework

**Contexto:** El documento funcional deja abierta la topología: Route Handlers de Next.js o un servicio Node.js independiente. El sistema tiene tres consumidores del mismo núcleo: la UI web, clientes REST y el servidor MCP.

**Decisión:** La API vive en los Route Handlers de Next.js. La lógica de negocio NO vive en los Route Handlers: reside en el paquete packages/core, escrito en TypeScript plano, sin ninguna dependencia de Next, de HTTP ni del SDK de MCP. Los Route Handlers y el servidor MCP son adaptadores delgados sobre ese núcleo.

**Justificación:** Para un sistema personal de un solo usuario, un servicio separado añade un segundo proceso, un segundo despliegue, CORS, y latencia de red interna sin beneficio real: no hay escalado independiente que justificarlo. El riesgo habitual de meter la API dentro de Next —acabar con lógica de negocio incrustada en handlers HTTP y con el MCP duplicándola— se elimina imponiendo la regla de dependencias del apartado 3.2. Si en el futuro se necesita un proceso Fastify independiente, la migración consiste en escribir un nuevo adaptador sobre el mismo core: es un cambio aditivo, no una reescritura.

**Consecuencias:** Un solo repositorio, un solo contenedor, una sola configuración de base de datos. El núcleo es testeable sin levantar HTTP. Contrapartida: el despliegue serverless por función queda descartado si se usa MCP sobre HTTP con sesiones; el objetivo de despliegue es un contenedor de larga vida (ver sección 17).

## 2.2 ADR-002 — Prisma como ORM

**Contexto:** El documento funcional propone Prisma o Drizzle sobre PostgreSQL.

**Decisión:** Prisma, con migraciones versionadas mediante prisma migrate y SQL manual para las restricciones que Prisma no expresa de forma nativa.

**Justificación:** Tres razones concretas para este proyecto. Primera: las migraciones declarativas de Prisma reducen el trabajo manual de esquema, que es el punto donde más tiempo se pierde en un proyecto de una sola persona. Segunda: las transacciones interactivas ($transaction con callback) son necesarias para el algoritmo de movimiento de la sección 6.4 y Prisma las soporta con un modelo claro de aislamiento. Tercera: Prisma Studio permite inspeccionar y corregir datos a mano durante el desarrollo y las pruebas, lo que ahorra escribir utilidades propias. Drizzle es más liviano y más cercano a SQL, pero su ventaja real —control fino de la consulta y arranque en frío mínimo— es irrelevante en un dominio de tres tablas con volúmenes personales.

**Consecuencias:** El binario de query engine añade peso a la imagen; es aceptable en despliegue por contenedor. Las restricciones DEFERRABLE y los índices parciales se escriben como SQL crudo dentro de los archivos de migración. El acceso a datos DEBE encapsularse en repositorios dentro de packages/core: ningún servicio ni handler invoca el cliente de Prisma directamente, para que un cambio de ORM afecte a una sola capa.

## 2.3 ADR-003 — Servidor MCP con doble transporte sobre un puerto de aplicación

**Contexto:** Se requiere que el MCP funcione tanto localmente con Claude Code como de forma remota desde cualquier cliente compatible. Un servidor local con acceso directo a la base de datos y un servidor remoto detrás de la API son dos formas de acceso muy distintas.

**Decisión:** Existe un único registro de herramientas MCP, escrito una sola vez, que depende de una interfaz TaskManagerPort. Esa interfaz tiene dos implementaciones intercambiables: CorePort, que invoca los servicios de packages/core en el mismo proceso, y HttpPort, que invoca la API REST con una API key. El transporte se selecciona por configuración: stdio para uso local con Claude Code y Streamable HTTP en la ruta /mcp de la aplicación web para clientes remotos.

**Justificación:** Duplicar la definición de las once herramientas para dos transportes garantiza que se desincronicen. Separar transporte (stdio frente a HTTP) de acceso a datos (núcleo frente a API) permite las cuatro combinaciones útiles sin escribir código nuevo: por ejemplo, stdio en la máquina del usuario contra una API remota, que es el escenario más probable en uso real.

**Consecuencias:** Las herramientas MCP no pueden asumir acceso a la base de datos: toda validación de autorización y toda regla de negocio DEBE estar en el núcleo o en la API, nunca en la capa de herramientas. Esto refuerza el principio del documento funcional de que el backend es la autoridad final.

## 2.4 ADR-004 — Ordenamiento por entero denso con reindexación transaccional

**Contexto:** El campo position determina el orden visual y debe persistir. Las opciones habituales son enteros con huecos, claves fraccionarias tipo LexoRank, o una secuencia densa reindexada.

**Decisión:** position es un entero denso base cero: las tareas de una columna ocupan siempre las posiciones 0 a n-1 sin huecos. Toda operación que altere el orden reindexa las columnas afectadas dentro de una única transacción.

**Justificación:** La posición forma parte del contrato con los agentes: una instrucción como mueve la tarea a la posición 2 debe significar exactamente la tercera tarjeta visible. Con huecos o claves fraccionarias, el valor almacenado deja de corresponder al índice visible y obliga al agente a razonar sobre un espacio de claves opaco, lo que contradice el principio de operaciones predecibles. El coste de reindexar es lineal sobre las tareas de dos columnas, con volúmenes de decenas de filas en uso personal, y elimina por completo la deriva de claves y la necesidad de rebalanceos periódicos.

**Consecuencias:** La restricción UNIQUE (column_id, position) DEBE declararse DEFERRABLE INITIALLY DEFERRED, porque durante la reindexación existen estados intermedios con posiciones duplicadas. El movimiento requiere bloqueo de fila sobre las tareas de las columnas origen y destino (sección 6.4). Si en el futuro una columna supera unos pocos miles de tareas, esta decisión debe reevaluarse.

## 2.5 ADR-005 — Autenticación por API key con hash y scopes

**Contexto:** El MVP es de un solo usuario, pero expone escritura y borrado a clientes externos y a agentes.

**Decisión:** Autenticación por API key en cabecera Authorization: Bearer. La clave se genera con 32 bytes aleatorios criptográficos, se muestra una única vez y se almacena como SHA-256 con pepper de servidor. Cada clave tiene scopes explícitos: read, write y delete.

**Justificación:** El scope delete separado es la contramedida directa al riesgo de operaciones destructivas de agentes descrito en la sección 14 del documento funcional: se puede entregar a un agente una clave sin capacidad de borrado sin cambiar una línea de código. El hash con pepper cumple el requisito de no persistir credenciales en texto plano. No se usa OAuth ni JWT porque no hay múltiples usuarios ni delegación de identidad que modelar en el MVP.

**Consecuencias:** No hay recuperación de una clave perdida: se revoca y se emite otra. La sesión de la UI web usa el mismo mecanismo mediante una clave de servidor que nunca llega al navegador; el navegador habla con la aplicación Next, no directamente con la API pública.

## 2.6 ADR-006 — Esquemas Zod como fuente única de contratos

**Contexto:** El mismo contrato de datos debe aplicarse en tres lugares: validación de entrada REST, esquemas de entrada de las herramientas MCP y documentación OpenAPI.

**Decisión:** Los esquemas Zod residen en packages/contracts y son la única definición. De ellos se derivan los tipos de TypeScript por inferencia, los esquemas JSON de las herramientas MCP y el documento OpenAPI, generado en tiempo de compilación.

**Justificación:** Evita el desfase entre lo que valida el servidor, lo que documenta OpenAPI y lo que el agente cree que puede enviar. Un agente que recibe un esquema de herramienta desactualizado produce llamadas inválidas de forma sistemática, y ese fallo es difícil de diagnosticar desde el lado del agente.

**Consecuencias:** La generación del documento OpenAPI forma parte del pipeline de compilación y su resultado se versiona en el repositorio para poder revisar los cambios de contrato en el diff.

# 3. Arquitectura de la solución

## 3.1 Vista de capas

```
  Navegador            Claude Code / Codex          curl / scripts
      |                   (MCP stdio)                (REST)
      v                        |                        |
  +-----------------+          |                        |
  | Next.js (React) |          |                        |
  |  Server Comps   |          |                        |
  +-----------------+          |                        |
      |                        |                        |
      v                        v                        v
  +---------------------------------------------------------+
  |  Adaptadores:  Route Handlers /api    |   MCP  /mcp      |
  |                (REST + auth)          |  (Streamable)    |
  +---------------------------------------------------------+
                          |
                          v
  +---------------------------------------------------------+
  |  packages/core  -  Service Layer                         |
  |  BoardService  ColumnService  TaskService  AuditService  |
  |  reglas de negocio, transacciones, errores de dominio    |
  +---------------------------------------------------------+
                          |
                          v
  +---------------------------------------------------------+
  |  Repositorios (packages/core)  ->  packages/db (Prisma)  |
  +---------------------------------------------------------+
                          |
                          v
                     PostgreSQL 16
```

Figura 1. Capas y sentido de las dependencias. Un servidor MCP remoto sustituye la flecha directa al núcleo por una llamada HTTP a /api.

## 3.2 Regla de dependencias

La regla es unidireccional y se verifica en revisión de código:

- packages/core NO importa Next, ni el SDK de MCP, ni ningún módulo de HTTP. Recibe datos ya validados y devuelve datos o lanza errores de dominio.

- Los adaptadores (Route Handlers y herramientas MCP) NO contienen reglas de negocio. Su responsabilidad se limita a: autenticar, validar la entrada con el esquema de contratos, invocar un servicio, y traducir el resultado o el error al formato de su protocolo.

- Ningún adaptador importa el cliente de Prisma. El acceso a datos pasa siempre por un repositorio del núcleo.

- packages/contracts no importa nada del proyecto: es una hoja del grafo de dependencias.

Prueba de la regla: si un servicio no se puede ejercitar en una prueba unitaria sin levantar un servidor HTTP, la regla está rota.

## 3.3 Estructura del repositorio

```
taskman/
  apps/
    web/                  Next.js: UI, /api/*, /mcp
      app/
        (board)/          rutas de UI
        api/              route handlers REST
        mcp/route.ts      transporte Streamable HTTP
      components/
    mcp-stdio/            entrypoint stdio para clientes locales
  packages/
    core/
      domain/             tipos de dominio y errores
      services/           BoardService, ColumnService, TaskService, AuditService
      repositories/       acceso a datos (unica capa que ve Prisma)
      mcp/                registro de herramientas + TaskManagerPort
    db/
      prisma/schema.prisma
      prisma/migrations/
    contracts/            esquemas Zod + generador de OpenAPI
  docker/
  openapi.json            generado, versionado
```

| Paquete | Responsabilidad | Puede importar |
| --- | --- | --- |
| packages/contracts | Esquemas Zod, tipos inferidos, generación de OpenAPI | nada del proyecto |
| packages/db | Esquema Prisma, migraciones, cliente singleton | nada del proyecto |
| packages/core | Servicios, repositorios, errores de dominio, herramientas MCP | contracts, db |
| apps/web | UI, adaptador REST, adaptador MCP sobre HTTP | contracts, core |
| apps/mcp-stdio | Arranque del servidor MCP por stdio | contracts, core |

Gestor de paquetes: pnpm workspaces. Node 20 LTS o superior. TypeScript en modo strict con noUncheckedIndexedAccess activado.

# 4. Modelo de datos físico

Cuatro tablas de dominio y dos tablas de soporte. Todos los identificadores son UUID v4 generados por la aplicación, no por la base de datos, para que la capa de servicios pueda construir grafos de objetos completos antes de escribir y para que las operaciones idempotentes puedan reproponer el mismo identificador.

## 4.1 Esquema Prisma

```
enum Priority { LOW MEDIUM HIGH URGENT }
enum ActorType { USER AGENT API }

model Board {
  id          String   @id @db.Uuid
  name        String   @db.VarChar(120)
  description String?  @db.VarChar(2000)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)
  columns     Column[]
  tasks       Task[]
  @@map("board")
}

model Column {
  id        String   @id @db.Uuid
  boardId   String   @map("board_id") @db.Uuid
  name      String   @db.VarChar(80)
  key       String   @db.VarChar(40)
  position  Int
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)
  board     Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  tasks     Task[]
  @@unique([boardId, key])
  @@index([boardId, position])
  @@map("board_column")
}

model Task {
  id          String   @id @db.Uuid
  boardId     String   @map("board_id") @db.Uuid
  columnId    String   @map("column_id") @db.Uuid
  title       String   @db.VarChar(200)
  description String?  @db.Text
  priority    Priority @default(MEDIUM)
  dueDate     DateTime? @map("due_date") @db.Date
  position    Int
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt      @map("updated_at") @db.Timestamptz(3)
  board       Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  column      Column   @relation(fields: [columnId], references: [id], onDelete: Restrict)
  @@index([columnId, position])
  @@index([boardId, priority])
  @@index([boardId, dueDate])
  @@map("task")
}

model AuditLog {
  id         BigInt   @id @default(autoincrement())
  actorType  ActorType @map("actor_type")
  actorName  String   @map("actor_name") @db.VarChar(120)
  clientId   String?  @map("client_id") @db.VarChar(120)
  action     String   @db.VarChar(60)
  entityType String   @map("entity_type") @db.VarChar(40)
  entityId   String   @map("entity_id") @db.VarChar(64)
  beforeData Json?    @map("before_data")
  afterData  Json?    @map("after_data")
  requestId  String?  @map("request_id") @db.VarChar(64)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  @@index([entityType, entityId, createdAt])
  @@index([createdAt])
  @@map("audit_log")
}

model ApiKey {
  id         String   @id @db.Uuid
  label      String   @db.VarChar(80)
  prefix     String   @unique @db.VarChar(16)
  hash       String   @db.Char(64)
  scopes     String[]
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz(3)
  revokedAt  DateTime? @map("revoked_at")  @db.Timestamptz(3)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  @@map("api_key")
}

model IdempotencyRecord {
  key         String   @id @db.VarChar(128)
  requestHash String   @map("request_hash") @db.Char(64)
  statusCode  Int      @map("status_code")
  responseBody Json    @map("response_body")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  @@index([createdAt])
  @@map("idempotency_record")
}
```

## 4.2 Restricciones añadidas por SQL manual

Las siguientes restricciones no son expresables en el esquema Prisma y DEBEN incluirse como SQL crudo en la migración inicial:

```
-- Orden denso por columna. Diferida: la reindexacion produce
-- estados intermedios con posiciones duplicadas dentro de la transaccion.
ALTER TABLE task
  ADD CONSTRAINT task_column_position_uniq
  UNIQUE (column_id, position) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE board_column
  ADD CONSTRAINT column_board_position_uniq
  UNIQUE (board_id, position) DEFERRABLE INITIALLY DEFERRED;

-- Coherencia referencial: la tarea y su columna pertenecen al mismo tablero.
ALTER TABLE board_column ADD CONSTRAINT column_board_pair UNIQUE (id, board_id);
ALTER TABLE task
  ADD CONSTRAINT task_column_same_board
  FOREIGN KEY (column_id, board_id)
  REFERENCES board_column (id, board_id) ON DELETE RESTRICT;

ALTER TABLE task ADD CONSTRAINT task_position_nonneg CHECK (position >= 0);
ALTER TABLE task ADD CONSTRAINT task_title_not_blank  CHECK (length(btrim(title)) > 0);

-- Busqueda por texto (RF-09).
CREATE INDEX task_search_idx ON task
  USING GIN (to_tsvector('spanish', title || ' ' || coalesce(description, '')));
```

La restricción task_column_same_board es la garantía estructural del requisito de seguridad cada operación debe validar que el recurso pertenece al tablero autorizado: aunque un fallo de la capa de servicios permitiera mover una tarea a una columna de otro tablero, la base de datos lo rechazaría.

## 4.3 Datos iniciales

Al crear un tablero sin especificar columnas, el sistema DEBE crear las cuatro columnas por defecto de la sección 4 del documento funcional, en este orden y con estas claves estables, que son las que los agentes usarán para resolver referencias por nombre:

| position | key | name |
| --- | --- | --- |
| 0 | BACKLOG | Backlog |
| 1 | TODO | Por hacer |
| 2 | IN_PROGRESS | En progreso |
| 3 | DONE | Completado |

# 5. Capa de servicios

## 5.1 Contratos

```
interface TaskService {
  create(input: CreateTaskInput, ctx: ActorContext): Promise<Task>;
  get(id: string, ctx: ActorContext): Promise<Task>;
  list(query: ListTasksQuery, ctx: ActorContext): Promise<Page<Task>>;
  search(text: string, q: SearchScope, ctx: ActorContext): Promise<Page<TaskMatch>>;
  update(id: string, patch: UpdateTaskInput, ctx: ActorContext): Promise<Task>;
  move(id: string, target: MoveTarget, ctx: ActorContext): Promise<MoveResult>;
  delete(id: string, ctx: ActorContext): Promise<void>;
}

interface ActorContext {
  actorType: "USER" | "AGENT" | "API";
  actorName: string;      // p.ej. "claude-code" o "web-ui"
  clientId?: string;      // prefijo de la API key usada
  scopes: Scope[];
  requestId: string;      // correlacion entre log, auditoria y respuesta
}

type MoveTarget = { columnId: string; position: number | "end" };

type MoveResult = {
  task: Task;
  fromColumnId: string;
  toColumnId: string;
  affectedColumns: { columnId: string; taskOrder: string[] }[];
};
```

MoveResult devuelve el orden final completo de las columnas afectadas. Esto cubre dos necesidades distintas con un solo diseño: la UI reconcilia su estado optimista sin volver a consultar, y el agente recibe el estado final resultante de su acción, tal como exige la sección 14 del documento funcional.

## 5.2 Reglas de negocio por operación

| Operación | Reglas que el servicio DEBE aplicar |
| --- | --- |
| create (tarea) | title no vacío tras recorte, máx. 200 caracteres. La columna debe existir y pertenecer al tablero indicado. Si se omite position, la tarea se inserta al final de la columna. Si se indica position, se inserta desplazando las siguientes. Registra auditoría CREATE. |
| update (tarea) | Patch parcial: solo los campos presentes se modifican. position y columnId NO son modificables aquí; requieren move. Si el patch no produce cambio efectivo, la operación es exitosa y no genera registro de auditoría. Registra auditoría UPDATE con before/after limitado a los campos modificados. |
| move | Algoritmo de la sección 5.4. Rechaza posiciones negativas. Una posición mayor que el tamaño de la columna destino se ajusta al final en lugar de fallar: el agente que calcula mal el índice obtiene un resultado útil, no un error. |
| delete (tarea) | Requiere scope delete. Reindexa la columna tras la eliminación. Registra auditoría DELETE con el estado completo previo en before_data. |
| delete (columna) | Falla con CONFLICT si contiene tareas, salvo que se indique reassignTo con otra columna del mismo tablero, en cuyo caso las tareas se mueven al final de esa columna en la misma transacción. |
| delete (tablero) | Elimina en cascada columnas y tareas. Requiere scope delete y confirmación explícita en la capa MCP. Registra un único evento de auditoría con el recuento de entidades eliminadas. |
| create (columna) | key único por tablero, normalizada a mayúsculas sin espacios. Se inserta en la posición indicada o al final. |

## 5.3 Errores de dominio

El núcleo lanza errores tipados que los adaptadores traducen a HTTP o a respuestas MCP. El núcleo nunca conoce códigos HTTP.

```
class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,     // "TASK_NOT_FOUND", "AMBIGUOUS_MATCH", ...
    readonly message: string,     // legible por humanos
    readonly details?: unknown,   // estructurado, accionable por un agente
    readonly hint?: string,       // que hacer a continuacion
  ) { super(message); }
}
```

El campo hint existe específicamente para los agentes: ante AMBIGUOUS_MATCH, details contiene la lista de candidatos con sus identificadores y hint indica que se debe reintentar con un identificador concreto. Esto convierte un error en una instrucción ejecutable en lugar de en un callejón sin salida.

## 5.4 Algoritmo de movimiento (RF-07, RF-08)

Es la operación con mayor riesgo de corrupción de datos del sistema. Se ejecuta en una única transacción con nivel de aislamiento REPEATABLE READ y bloqueo explícito de las filas afectadas.

```
async move(taskId, { columnId: toColumnId, position }, ctx) {
  return this.db.transaction(async (tx) => {

    // 1. Bloquear la tarea y resolver su estado actual.
    const task = await tx.lockTaskForUpdate(taskId);
    if (!task) throw new DomainError("TASK_NOT_FOUND", ...);

    // 2. Validar el destino. La FK compuesta ya lo garantiza, pero un
    //    error de dominio explicito es mas util que una violacion de FK.
    const toColumn = await tx.getColumn(toColumnId);
    if (!toColumn || toColumn.boardId !== task.boardId)
      throw new DomainError("COLUMN_NOT_IN_BOARD", ...);

    // 3. Bloquear en orden estable de UUID para evitar interbloqueos
    //    cuando dos movimientos cruzan las mismas dos columnas.
    const ids = [task.columnId, toColumnId].sort();
    const rows = await tx.lockTasksOfColumnsForUpdate(ids);

    // 4. Calcular el nuevo orden en memoria.
    const from = rows.filter(t => t.columnId === task.columnId)
                     .sort(byPosition)
                     .filter(t => t.id !== taskId);
    const to   = task.columnId === toColumnId
                   ? from
                   : rows.filter(t => t.columnId === toColumnId).sort(byPosition);

    const index = position === "end"
      ? to.length
      : Math.max(0, Math.min(position, to.length));
    to.splice(index, 0, { ...task, columnId: toColumnId });

    // 5. Persistir. La UNIQUE diferida tolera los duplicados intermedios
    //    y se valida al COMMIT.
    await tx.rewritePositions(task.columnId, from);
    if (toColumnId !== task.columnId) await tx.rewritePositions(toColumnId, to);

    await this.audit.record(tx, "MOVE", "TASK", taskId,
      { columnId: task.columnId, position: task.position },
      { columnId: toColumnId,   position: index }, ctx);

    return buildMoveResult(...);
  });
}
```

Notas de implementación de obligado cumplimiento:

- El bloqueo de columnas DEBE hacerse en orden lexicográfico de identificador. Sin este orden, dos movimientos simultáneos en sentidos opuestos entre las mismas columnas producen un interbloqueo.

- rewritePositions escribe siempre la secuencia completa 0..n-1 de la columna, no diferencias. Es más escrituras, pero elimina toda posibilidad de huecos o duplicados persistentes.

- Ante un error de serialización de PostgreSQL (SQLSTATE 40001), el adaptador REINTENTA la transacción hasta dos veces antes de devolver un error al cliente.

- Mover una tarea dentro de su misma columna es un caso del mismo algoritmo, no una rama separada.

# 6. Contrato de la API REST

## 6.1 Convenciones

- Prefijo /api. Sin versión en la ruta durante el MVP; la versión pública versionada es una evolución futura del documento base.

- Content-Type: application/json en petición y respuesta. Codificación UTF-8.

- Fechas en ISO 8601. due_date es una fecha sin hora (YYYY-MM-DD); los campos created_at y updated_at incluyen zona horaria.

- Nombres de campo en snake_case en el borde HTTP; camelCase dentro del código. La traducción ocurre en el adaptador.

- Toda respuesta incluye la cabecera X-Request-Id, que coincide con el request_id de los registros de auditoría y de log.

- Listados paginados por cursor: parámetros limit (por defecto 50, máximo 200) y cursor; respuesta con items y next_cursor.

## 6.2 Endpoints

| Método y ruta | Uso | Scope | RF |
| --- | --- | --- | --- |
| GET /api/boards | Listar tableros | read | — |
| POST /api/boards | Crear tablero (con columnas por defecto) | write | RF-01 |
| GET /api/boards/{id} | Tablero con columnas y recuento de tareas | read | — |
| PATCH /api/boards/{id} | Actualizar nombre o descripción | write | — |
| DELETE /api/boards/{id} | Eliminar tablero en cascada | delete | — |
| POST /api/boards/{id}/columns | Crear columna | write | RF-02 |
| PATCH /api/columns/{id} | Renombrar o reordenar columna | write | — |
| DELETE /api/columns/{id} | Eliminar columna (con reassign_to opcional) | delete | — |
| GET /api/tasks | Listar y filtrar tareas | read | RF-04 |
| GET /api/tasks/search | Búsqueda por texto | read | RF-09 |
| POST /api/tasks | Crear tarea | write | RF-03 |
| GET /api/tasks/{id} | Consultar tarea | read | — |
| PATCH /api/tasks/{id} | Actualizar campos editables | write | RF-05 |
| DELETE /api/tasks/{id} | Eliminar tarea | delete | RF-06 |
| POST /api/tasks/{id}/move | Mover entre columnas y posiciones | write | RF-07, RF-08 |
| GET /api/audit | Consultar registro de auditoría | read | RF-10 |
| GET /api/health | Sonda de salud (sin autenticación) | — | — |

## 6.3 Contratos detallados

### 6.3.1 POST /api/tasks

```
POST /api/tasks
Authorization: Bearer tmk_live_7f3a...
Idempotency-Key: 1f0c2b64-...        (opcional)

{
  "board_id": "0f2d...",
  "column_id": "5a91...",            // o "column_key": "TODO"
  "title": "Revisar HU-25",
  "description": "Validar criterios de aceptacion",
  "priority": "HIGH",                // LOW | MEDIUM | HIGH | URGENT
  "due_date": "2026-09-11",
  "position": null                   // null => al final de la columna
}

201 Created
{
  "id": "c14e...",
  "board_id": "0f2d...",
  "column_id": "5a91...",
  "title": "Revisar HU-25",
  "description": "Validar criterios de aceptacion",
  "priority": "HIGH",
  "due_date": "2026-09-11",
  "position": 3,
  "created_at": "2026-09-06T14:22:11.482Z",
  "updated_at": "2026-09-06T14:22:11.482Z"
}
```

column_key es una alternativa a column_id dentro del mismo tablero. Existe para que un agente pueda crear una tarea en TODO sin una consulta previa de resolución, reduciendo a la mitad las llamadas del caso de uso más frecuente. Si se envían ambos, column_id prevalece.

### 6.3.2 GET /api/tasks

| Parámetro | Tipo | Descripción |
| --- | --- | --- |
| board_id | uuid | Obligatorio salvo que se indique column_id. |
| column_id | uuid | Filtra por columna. |
| column_key | string | Alternativa a column_id dentro del tablero indicado. |
| priority | enum, repetible | priority=HIGH&priority=URGENT actúa como OR. |
| due_before / due_after | date | Rango sobre due_date. Excluye tareas sin fecha. |
| overdue | boolean | true devuelve tareas con due_date anterior a hoy fuera de la columna DONE. |
| order_by | enum | position (por defecto), due_date, priority, created_at. |
| limit / cursor | int / string | Paginación por cursor. |

### 6.3.3 POST /api/tasks/{id}/move

```
{ "column_id": "9b02...", "position": 0 }
   // o bien: { "column_key": "IN_PROGRESS", "position": "end" }

200 OK
{
  "task": { ... },
  "from_column_id": "5a91...",
  "to_column_id": "9b02...",
  "affected_columns": [
    { "column_id": "5a91...", "task_order": ["a1..", "b2.."] },
    { "column_id": "9b02...", "task_order": ["c14e..", "d3..", "e4.."] }
  ]
}
```

## 6.4 Modelo de errores

Todos los errores comparten una única envoltura. El campo details es siempre estructurado para permitir que un agente reaccione de forma programática.

```
HTTP 409
{
  "error": {
    "code": "AMBIGUOUS_MATCH",
    "message": "Hay 2 tareas que coinciden con 'Revisar HU-25'.",
    "details": {
      "candidates": [
        { "id": "c14e...", "title": "Revisar HU-25", "column_key": "TODO" },
        { "id": "f88b...", "title": "Revisar HU-25", "column_key": "DONE" }
      ]
    },
    "hint": "Reintenta indicando el id exacto de la tarea deseada.",
    "request_id": "req_01J8..."
  }
}
```

| code | HTTP | Cuándo se produce |
| --- | --- | --- |
| VALIDATION_ERROR | 400 | La entrada no supera el esquema Zod. details contiene la lista de campos y el motivo. |
| UNAUTHENTICATED | 401 | Falta la cabecera Authorization o la clave no existe o está revocada. |
| FORBIDDEN_SCOPE | 403 | La clave es válida pero carece del scope requerido. details indica el scope necesario. |
| BOARD_NOT_FOUND | 404 | El tablero no existe. |
| COLUMN_NOT_FOUND | 404 | La columna no existe. |
| TASK_NOT_FOUND | 404 | La tarea no existe o ya fue eliminada. |
| COLUMN_NOT_IN_BOARD | 409 | La columna destino pertenece a otro tablero. |
| AMBIGUOUS_MATCH | 409 | Una resolución por nombre devolvió más de un candidato. |
| COLUMN_NOT_EMPTY | 409 | Se intentó eliminar una columna con tareas sin indicar reassign_to. |
| DUPLICATE_KEY | 409 | Ya existe una columna con esa key en el tablero. |
| IDEMPOTENCY_MISMATCH | 422 | La Idempotency-Key se reutilizó con un cuerpo distinto. |
| CONFIRMATION_REQUIRED | 428 | Operación destructiva o masiva sin confirmación explícita. |
| RATE_LIMITED | 429 | Se superó el límite de peticiones de la clave. |
| INTERNAL_ERROR | 500 | Fallo no controlado. El mensaje no expone detalles internos; el request_id permite correlacionar con el log. |

## 6.5 Idempotencia

Aplica a POST /api/boards, POST /api/tasks y POST /api/boards/{id}/columns. Si la petición incluye la cabecera Idempotency-Key, el adaptador calcula el SHA-256 del cuerpo canonicalizado y consulta idempotency_record:

- Sin registro previo: se ejecuta la operación y se almacena clave, hash, código de estado y cuerpo de respuesta en la misma transacción.

- Registro con el mismo hash: se devuelve la respuesta almacenada y la cabecera Idempotency-Replayed: true, sin volver a ejecutar nada.

- Registro con hash distinto: error IDEMPOTENCY_MISMATCH (422).

- Los registros con más de 24 horas se purgan mediante una tarea programada diaria.

Las operaciones PATCH, DELETE y move ya son idempotentes por naturaleza en su efecto final y no requieren esta cabecera.

# 7. Seguridad

## 7.1 API keys

- Formato: tmk_live_ seguido de 32 bytes aleatorios en base62. El prefijo visible es tmk_live_ más los primeros 6 caracteres y se almacena en claro para poder identificar la clave en el log y en la auditoría sin conocerla.

- Almacenamiento: SHA-256 de la clave concatenada con un pepper leído de la variable de entorno API_KEY_PEPPER. El pepper NO se almacena en la base de datos.

- La clave completa se muestra una única vez, en el momento de la creación mediante el script de administración.

- Verificación en tiempo constante para evitar ataques de temporización. El resultado se cachea en memoria durante 60 segundos para no consultar la base de datos en cada petición.

- last_used_at se actualiza como máximo una vez por minuto por clave, para no convertir cada lectura en una escritura.

## 7.2 Scopes

| Scope | Permite |
| --- | --- |
| read | GET sobre todos los recursos, incluido el registro de auditoría. |
| write | POST y PATCH, incluido move. No permite eliminar. |
| delete | DELETE de tareas, columnas y tableros. |

Recomendación operativa: la clave que se entrega a un agente autónomo se emite con read y write únicamente. Una clave con delete se reserva para uso interactivo supervisado. Esta separación es la contramedida práctica al riesgo de operaciones masivas destructivas.

## 7.3 Otras medidas

- La UI web nunca envía la API key al navegador. Los Server Components y las Server Actions invocan el núcleo directamente en el servidor.

- Límite de peticiones por clave: 120 por minuto para lectura y 30 por minuto para escritura, con ventana deslizante en memoria. Al superarlo se responde 429 con la cabecera Retry-After.

- CORS deshabilitado por defecto. Si se habilita, se restringe a una lista explícita definida por configuración.

- PostgreSQL no se expone fuera de la red del contenedor. Ningún agente recibe jamás una cadena de conexión.

- Los cuerpos de petición se limitan a 256 KB.

- Los registros de log NO incluyen claves, ni siquiera parcialmente más allá del prefijo público.

## 7.4 Auditoría (RF-10)

AuditService escribe dentro de la misma transacción que la operación auditada: si la operación falla, no queda registro huérfano; si el registro falla, la operación se revierte.

| Acción | before_data | after_data |
| --- | --- | --- |
| CREATE | null | Entidad completa |
| UPDATE | Solo los campos modificados, con su valor previo | Solo los campos modificados, con su valor nuevo |
| MOVE | { column_id, position } | { column_id, position } |
| DELETE | Entidad completa | null |
| BULK_DELETE | { count, entity_ids } | null |

Las lecturas no se auditan. actor_type se deriva del origen: USER para la UI web, AGENT para peticiones que llegan por MCP, API para el resto de clientes REST.

# 8. Servidor MCP

## 8.1 Arquitectura y transportes

```
           registro unico de herramientas (packages/core/mcp)
                              |
                    interface TaskManagerPort
                       /                 \
                CorePort                HttpPort
        (servicios en proceso)     (fetch contra /api + API key)

  transportes:
    apps/mcp-stdio      -> StdioServerTransport      (Claude Code local)
    apps/web/app/mcp    -> StreamableHTTPTransport   (clientes remotos)
```

| Escenario | Transporte | Port | Configuración |
| --- | --- | --- | --- |
| Claude Code en la misma máquina que la base de datos | stdio | CorePort | MCP_PORT_MODE=core, DATABASE_URL |
| Claude Code local contra servidor remoto (caso habitual) | stdio | HttpPort | MCP_PORT_MODE=http, TASKMAN_API_URL, TASKMAN_API_KEY |
| Cliente MCP remoto sobre HTTP | Streamable HTTP | CorePort | Autenticación por Bearer en la propia ruta /mcp |

El endpoint /mcp DEBE exigir la misma autenticación por API key que /api y aplicar los mismos scopes. Un cliente MCP remoto sin scope delete no ve disponible la herramienta delete_task: el filtrado ocurre en el listado de herramientas, no solo en la ejecución, para que el agente no planifique acciones que no puede completar.

## 8.2 Catálogo de herramientas

| Herramienta | Scope | Destructiva | Servicio invocado |
| --- | --- | --- | --- |
| list_boards | read | No | BoardService.list |
| get_board | read | No | BoardService.get |
| create_board | write | No | BoardService.create |
| create_column | write | No | ColumnService.create |
| list_tasks | read | No | TaskService.list |
| search_tasks | read | No | TaskService.search |
| get_task | read | No | TaskService.get |
| create_task | write | No | TaskService.create |
| update_task | write | No | TaskService.update |
| move_task | write | No | TaskService.move |
| delete_task | delete | Sí | TaskService.delete |

## 8.3 Diseño de las herramientas

Las herramientas no son una proyección mecánica de los endpoints. Se diseñan alrededor de la forma en que un agente expresa una intención, siguiendo las reglas de la sección 14 del documento funcional.

### 8.3.1 Resolución por nombre

Toda herramienta que opera sobre una entidad concreta acepta el identificador o un nombre. La regla de resolución es uniforme y DEBE implementarse en un único módulo compartido:

- Si se recibe un UUID válido, se usa directamente.

- Si se recibe texto, se busca coincidencia exacta sin distinguir mayúsculas dentro del ámbito indicado (tablero, y opcionalmente columna).

- Exactamente una coincidencia: se procede.

- Cero coincidencias: se reintenta con coincidencia parcial. Si sigue sin haber resultados, se devuelve NOT_FOUND incluyendo en details hasta cinco títulos próximos, para que el agente pueda reformular.

- Más de una coincidencia: AMBIGUOUS_MATCH con la lista completa de candidatos, sus identificadores y su columna. La herramienta NO elige por el usuario.

### 8.3.2 Confirmación de operaciones destructivas

delete_task exige el parámetro confirm: true. Sin él devuelve CONFIRMATION_REQUIRED junto con el detalle completo de la tarea que se eliminaría. El agente debe presentar esa información y reintentar con confirmación. La política se controla mediante la variable MCP_DESTRUCTIVE_POLICY, con valores confirm (por defecto), allow o deny.

### 8.3.3 Operaciones masivas

No existe una herramienta de borrado masivo en el MVP. El caso de uso mueve a TODO todas las tareas de EPX-25 que estén en BACKLOG se resuelve con list_tasks seguido de move_task por cada elemento. Esta decisión es deliberada: obliga al agente a enumerar y a mostrar el alcance antes de actuar, y hace que un fallo parcial sea visible y reparable elemento a elemento en lugar de dejar un estado ambiguo.

## 8.4 Esquemas de entrada

```
// move_task
{
  task: z.string().describe(
    "Id de la tarea o titulo exacto. Si el titulo es ambiguo la herramienta devuelve los candidatos."),
  board: z.string().optional().describe(
    "Id o nombre del tablero. Obligatorio si se identifica la tarea por titulo."),
  to_column: z.string().describe("Id, key (TODO, DONE) o nombre de la columna."),
  position: z.union([z.number().int().min(0), z.literal("end")]).default("end")
}

// list_tasks
{
  board: z.string().describe("Id o nombre del tablero."),
  column: z.string().optional(),
  priority: z.array(z.enum(["LOW","MEDIUM","HIGH","URGENT"])).optional(),
  overdue: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50)
}
```

Cada campo DEBE llevar una descripción. La calidad de esas descripciones determina directamente la tasa de acierto del agente: son parte del contrato, no comentarios.

## 8.5 Formato de respuesta

Cada herramienta devuelve contenido de texto legible y, además, un bloque JSON con el estado final. El texto permite al agente redactar su respuesta al usuario; el JSON le permite encadenar la siguiente llamada sin volver a consultar.

```
Tarea movida.
  "Revisar HU-25"  TODO -> IN PROGRESS  (posicion 0)
  IN PROGRESS contiene ahora 3 tareas.

```json
{"task":{"id":"c14e...","column_key":"IN_PROGRESS","position":0},
 "affected_columns":[...]}
```
```

## 8.6 Configuración del cliente

```
// .mcp.json  (Claude Code, transporte stdio contra API remota)
{
  "mcpServers": {
    "taskman": {
      "command": "node",
      "args": ["./apps/mcp-stdio/dist/index.js"],
      "env": {
        "MCP_PORT_MODE": "http",
        "TASKMAN_API_URL": "https://taskman.midominio.com",
        "TASKMAN_API_KEY": "tmk_live_...",
        "MCP_DESTRUCTIVE_POLICY": "confirm"
      }
    }
  }
}
```

# 9. Frontend

## 9.1 Estructura y estado

- Next.js App Router. La carga inicial del tablero se hace en un Server Component invocando el núcleo directamente, sin pasar por HTTP.

- Las mutaciones desde el navegador usan Server Actions, que invocan los mismos servicios. La UI no consume su propia API pública.

- TanStack Query gestiona el estado del cliente y la revalidación. Clave de caché: ["board", boardId].

- Drag and drop con dnd-kit. Se descarta react-beautiful-dnd por estar sin mantenimiento activo.

## 9.2 Movimiento optimista

El requisito de que el cambio persista al recargar exige reconciliación, no solo actualización optimista:

- Al soltar la tarjeta, se reordena el estado local de inmediato y se guarda una instantánea del estado previo.

- Se invoca la acción de movimiento. La respuesta MoveResult contiene el orden final autoritativo de las columnas afectadas.

- En caso de éxito, el estado local se sustituye por ese orden, no se conserva el calculado localmente. Esto corrige cualquier divergencia causada por una operación concurrente de un agente.

- En caso de error, se restaura la instantánea y se muestra una notificación con el mensaje del error de dominio.

## 9.3 Componentes

| Componente | Responsabilidad |
| --- | --- |
| BoardHeader | Nombre del tablero, selector de tablero, filtros y acción de nueva tarea. |
| ColumnList | Contenedor con scroll horizontal; gestiona el contexto de dnd-kit. |
| ColumnCard | Cabecera de columna con nombre y recuento; zona de destino de arrastre. |
| TaskCard | Título, indicador de prioridad, fecha límite y marca de vencimiento. |
| TaskDetailPanel | Panel lateral de edición; guardado por campo al perder el foco. |
| QuickAddInput | Creación de tarea escribiendo el título al final de una columna. |

Indicadores visuales obligatorios: prioridad URGENT y HIGH diferenciadas, y marca de vencida para toda tarea con due_date anterior a hoy que no esté en la columna DONE. El diseño es responsive: en pantallas estrechas las columnas se muestran de una en una con navegación por pestañas.

# 10. Estrategia de pruebas

El sistema tiene tres superficies de entrada sobre un mismo núcleo. La estrategia concentra la verificación de reglas en el núcleo y comprueba en cada adaptador únicamente lo que ese adaptador aporta.

| Nivel | Herramienta | Qué verifica | Criterio de salida |
| --- | --- | --- | --- |
| Unitario | Vitest | Reglas de negocio y algoritmo de posición con repositorios en memoria. | Cobertura de ramas mínima del 90 % en packages/core/services. |
| Integración de datos | Vitest + PostgreSQL en Docker | Restricciones, transacciones, cascadas, unicidad diferida. | Todas las restricciones de la sección 4.2 tienen al menos una prueba que las viola y comprueba el rechazo. |
| Contrato REST | Vitest + fetch contra el servidor | Códigos HTTP, forma de la respuesta, scopes, idempotencia. | Todo endpoint de la sección 6.2 cubierto en caso de éxito, no autorizado y validación fallida. |
| Contrato MCP | Cliente MCP en memoria | Esquemas de herramienta, resolución por nombre, desambiguación, confirmación. | Las once herramientas ejecutadas; los tres caminos de resolución cubiertos. |
| Extremo a extremo | Playwright | Flujos de usuario en navegador y persistencia real. | Los escenarios de la sección 10.2 en verde sobre datos sembrados. |

## 10.1 Casos críticos de concurrencia

Estos casos DEBEN existir como pruebas automatizadas; son los que rompen el modelo de datos si el algoritmo de movimiento es incorrecto:

- Dos movimientos simultáneos hacia la misma posición de la misma columna: ambos terminan, el orden final es denso y sin duplicados.

- Movimientos cruzados simultáneos A→B y B→A: no se produce interbloqueo (verifica el orden de bloqueo de la sección 5.4).

- Eliminación de una tarea mientras se mueve otra de la misma columna: el orden final es denso.

- Creación concurrente con la misma Idempotency-Key: se crea exactamente una tarea.

## 10.2 Escenarios de extremo a extremo

- CT-01. Crear tablero, verificar que aparecen las cuatro columnas por defecto.

- CT-02. Crear tarea con QuickAdd, recargar, verificar que persiste en la posición correcta.

- CT-03. Arrastrar una tarjeta entre columnas, recargar, verificar columna y posición (RF-07, RF-08).

- CT-04. Editar título, prioridad y fecha en el panel de detalle; verificar el reflejo en la tarjeta.

- CT-05. Eliminar una tarea intermedia y verificar que el orden restante queda denso.

- CT-06. Crear una tarea vía API con la UI abierta y verificar que aparece tras la revalidación.

- CT-07. Mover una tarea vía MCP y verificar el reflejo en la UI (criterio de aceptación del documento base).

- CT-08. Petición con clave sin scope delete: la UI de eliminación por API responde 403 y no altera datos.

- CT-09. Filtrar por prioridad y por tareas vencidas; verificar el conjunto resultante.

- CT-10. Verificar que una operación destructiva deja un registro en audit_log con before_data completo.

## 10.3 Datos de prueba y entorno

Cada archivo de prueba de integración se ejecuta contra un esquema PostgreSQL propio, creado y destruido en el ciclo de vida de la suite, para permitir paralelismo sin interferencias. Existe un script de siembra determinista, invocable con una semilla fija, que genera un tablero con las cuatro columnas y un conjunto conocido de tareas; las pruebas de extremo a extremo parten siempre de ese estado. No se comparten datos entre pruebas.

# 11. Observabilidad, configuración y despliegue

## 11.1 Log y trazabilidad

- Log estructurado en JSON con pino. Un identificador de petición se genera en el borde y acompaña a todo el procesamiento.

- Cada petición registra: request_id, método, ruta, código de estado, duración, prefijo de la clave y tipo de actor.

- Las herramientas MCP registran adicionalmente el nombre de la herramienta y el resultado de la resolución por nombre. Ese registro es la principal fuente de diagnóstico cuando un agente se comporta de forma inesperada.

- Los errores 500 registran la traza completa; la respuesta al cliente solo expone el código y el request_id.

- GET /api/health comprueba conectividad con la base de datos y devuelve la versión desplegada.

## 11.2 Variables de entorno

| Variable | Ámbito | Descripción |
| --- | --- | --- |
| DATABASE_URL | web, mcp-stdio (modo core) | Cadena de conexión a PostgreSQL. |
| API_KEY_PEPPER | web | Secreto de servidor para el hash de las claves. Rotarlo invalida todas las claves. |
| NODE_ENV | todos | development, test o production. |
| LOG_LEVEL | todos | debug, info, warn o error. |
| MCP_PORT_MODE | mcp-stdio | core o http. |
| TASKMAN_API_URL | mcp-stdio (modo http) | URL base de la API. |
| TASKMAN_API_KEY | mcp-stdio (modo http) | API key usada por el servidor MCP. |
| MCP_DESTRUCTIVE_POLICY | mcp | confirm, allow o deny. |
| RATE_LIMIT_ENABLED | web | Permite desactivar el límite en entornos de prueba. |

La configuración se valida al arrancar con un esquema Zod. Una variable ausente o inválida DEBE impedir el arranque del proceso con un mensaje explícito, no producir un fallo posterior en tiempo de ejecución.

## 11.3 Despliegue

- Imagen Docker multi-etapa: compilación con dependencias completas, ejecución con dependencias de producción y usuario sin privilegios.

- docker compose con dos servicios: aplicación y PostgreSQL 16 con volumen persistente. El puerto de PostgreSQL no se publica al exterior.

- Las migraciones se aplican con prisma migrate deploy en un paso previo al arranque, nunca de forma automática desde el proceso de la aplicación.

- Copia de seguridad: pg_dump diario al volumen de respaldo, con retención de siete días. Es responsabilidad operativa mínima, pero obligatoria: el sistema es la fuente única de verdad de las tareas.

# 12. Plan de implementación

Cada fase es entregable y verificable de forma independiente. Una fase no comienza hasta que la definición de terminado de la anterior se cumple por completo.

| Fase | Entregable | Definición de terminado |
| --- | --- | --- |
| F1 — Fundación | Monorepo, contratos Zod, esquema Prisma y migraciones, repositorios y servicios con reglas de negocio. | Pruebas unitarias y de integración de datos en verde. Todas las restricciones de la sección 4.2 aplicadas y probadas. Ningún adaptador escrito todavía. |
| F2 — API REST | Route Handlers, autenticación por API key con scopes, límite de peticiones, idempotencia, OpenAPI generado. | Todos los endpoints de la sección 6.2 responden según contrato. Pruebas de contrato REST en verde. openapi.json versionado y coherente con los esquemas. |
| F3 — Web UI | Tablero Kanban, CRUD visual, drag and drop con reconciliación, filtros, panel de detalle. | CT-01 a CT-05 y CT-09 en verde. Comportamiento responsive verificado. |
| F4 — MCP | Registro de herramientas, TaskManagerPort con ambas implementaciones, transportes stdio y HTTP. | Las once herramientas ejecutables desde Claude Code en modo http y desde un cliente remoto. CT-07 en verde. |
| F5 — Endurecimiento | Resolución por nombre y desambiguación, política de confirmación, auditoría completa, pruebas de concurrencia. | Casos de la sección 10.1 en verde. CT-08 y CT-10 en verde. Los cinco ejemplos de interacción del documento funcional ejecutados con éxito desde un agente real. |

## 12.1 Criterios de aceptación técnicos

Trazabilidad entre los criterios del documento funcional y su verificación en este documento.

| Criterio del documento base | Verificación |
| --- | --- |
| Crear tablero y columnas desde la UI | CT-01 |
| Crear, editar y eliminar tareas | CT-02, CT-04, CT-05 |
| Movimiento por arrastre que persiste al recargar | CT-03 + pruebas de concurrencia 10.1 |
| La API permite todas las operaciones CRUD | Pruebas de contrato REST, todos los endpoints de 6.2 |
| Un cliente autenticado consume la API sin la UI | Pruebas de contrato REST con clave de scope limitado |
| Un cliente MCP lista, crea, actualiza, elimina y mueve | Pruebas de contrato MCP + CT-07 |
| Una operación por API o MCP se refleja en la UI | CT-06, CT-07 |
| Las operaciones críticas generan auditoría | CT-10 + pruebas de AuditService |
| Errores descriptivos y accionables para un agente | Catálogo de la sección 6.4 con details y hint verificados por código de error |

## 12.2 Riesgos técnicos

| ID | Riesgo | Mitigación |
| --- | --- | --- |
| RT-01 | Corrupción del orden por escrituras concurrentes de UI y agente. | Unicidad diferida, bloqueo ordenado de filas, reescritura completa de posiciones y pruebas de concurrencia obligatorias (10.1). |
| RT-02 | Un agente elimina o mueve masivamente lo que no debía. | Scope delete separado, confirmación explícita, ausencia de herramientas masivas y auditoría con estado previo completo. |
| RT-03 | Desfase entre esquema Zod, OpenAPI y esquemas de herramienta MCP. | Fuente única en packages/contracts (ADR-006) y openapi.json versionado para revisar los cambios en el diff. |
| RT-04 | Lógica de negocio filtrándose a los Route Handlers y desapareciendo del MCP. | Regla de dependencias de 3.2 verificada en revisión; los servicios se prueban sin HTTP. |
| RT-05 | Baja tasa de acierto del agente por descripciones de herramienta pobres. | Descripciones obligatorias por campo, resolución por nombre uniforme y errores con hint accionable. |
| RT-06 | Reindexación costosa si una columna crece mucho más de lo previsto. | Umbral de vigilancia en 2 000 tareas por columna; superado ese punto, reevaluar ADR-004 hacia claves fraccionarias. |

# Anexo A. Ejemplos de interacción resueltos

Traducción de los ejemplos de la sección 11 del documento funcional a secuencias concretas de herramientas MCP.

| Instrucción del usuario | Secuencia de herramientas |
| --- | --- |
| Crea una tarea llamada Revisar HU-25 en el tablero QA y colócala en TODO. | create_task(board:"QA", column:"TODO", title:"Revisar HU-25") — una sola llamada, gracias a la resolución por nombre y a column_key. |
| Mueve Revisar HU-25 a IN PROGRESS. | move_task(task:"Revisar HU-25", board:"QA", to_column:"IN_PROGRESS"). Si hay dos coincidencias, devuelve AMBIGUOUS_MATCH con los candidatos y el agente pregunta. |
| Pon Revisar HU-25 con prioridad alta y fecha límite el viernes. | update_task(task:"Revisar HU-25", priority:"HIGH", due_date:"2026-09-11"). La resolución de el viernes a fecha concreta es responsabilidad del agente, no del servidor. |
| Muéstrame todas las tareas pendientes del tablero EPX. | list_tasks(board:"EPX", column:"TODO") o list_tasks(board:"EPX") filtrando en el agente si se requiere excluir DONE. |
| Mueve a TODO todas las tareas de EPX-25 que estén en BACKLOG. | list_tasks(board:"EPX-25", column:"BACKLOG") y después move_task por cada elemento. El agente resume el alcance antes de ejecutar (sección 8.3.3). |

# Anexo B. Glosario

| Término | Definición en este documento |
| --- | --- |
| Adaptador | Capa que traduce un protocolo (HTTP, MCP) a llamadas al núcleo. No contiene reglas de negocio. |
| Núcleo (core) | packages/core. Servicios, repositorios y errores de dominio, sin dependencias de framework. |
| Port | Interfaz TaskManagerPort que abstrae de dónde obtienen los datos las herramientas MCP. |
| Orden denso | Secuencia de posiciones 0..n-1 sin huecos dentro de una columna. |
| Scope | Permiso asociado a una API key: read, write o delete. |
| request_id | Identificador de correlación presente en la respuesta, el log y el registro de auditoría. |
