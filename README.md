# TaskMan

Gestor de tareas Kanban personal con API REST y servidor MCP para agentes de IA.

Especificación en `docs/`:
- Documento Técnico-Funcional v1.0
- Especificación Técnica de Desarrollo v1.0

Estado: F2.1 — servidor MCP por stdio con tres herramientas.

## Puesta en marcha

```powershell
Copy-Item .env.example .env    # solo la primera vez
pnpm install
pnpm run verify                # levanta la base, migra, compila y corre las pruebas
```

`verify` deja construido `apps/mcp-stdio/dist/index.js`, que es lo que arranca
el servidor MCP.

## Servidor MCP (F2.1)

Tres herramientas —`list_tasks`, `create_task`, `move_task`— sobre el transporte
stdio de la sección 8.1 de la especificación, en modo `core`: los servicios
corren en el mismo proceso y hablan con PostgreSQL directamente, sin pasar por
HTTP. El modo `http` de la 8.1 todavía no existe y el servidor falla al
arrancar si se lo pide.

### Usarlo desde Claude Code

El `.mcp.json` lleva credenciales en su bloque `env`, así que está
gitignoreado igual que el `.env`: copiá `.mcp.json.example` a `.mcp.json` y
completá los valores (la `DATABASE_URL` es la misma del `.env`).

```powershell
Copy-Item .mcp.json.example .mcp.json           # solo la primera vez, y completalo
pnpm run db:up                                  # PostgreSQL en Docker
pnpm --filter @taskman/mcp-stdio run build      # o pnpm run build
claude
```

Claude Code toma el `.mcp.json` del directorio desde el que arranca y pide
confirmación la primera vez. `/mcp` dentro de la sesión muestra el estado del
servidor y sus herramientas.

Las tres herramientas resuelven tableros, columnas y tareas por nombre además
de por id, así que "creá 'Revisar HU-25' en TODO del tablero QA" es una sola
llamada. Si un nombre es ambiguo, la herramienta devuelve `AMBIGUOUS_MATCH` con
los candidatos y no elige: hay que desambiguar.

### Borrado de tareas

`delete_task` es la única herramienta destructiva del catálogo (sección 8.2) y
se controla con `MCP_DESTRUCTIVE_POLICY` en el bloque `env` del `.mcp.json`:

| Valor | Qué hace |
| --- | --- |
| `confirm` (por defecto) | La llamada sin `confirm: true` no borra: devuelve `CONFIRMATION_REQUIRED` con la tarea entera —título, columna, prioridad, vencimiento y descripción— para que el agente te la muestre. Recién la segunda llamada, con `confirm: true`, la elimina. |
| `allow` | Borra de inmediato, sin el paso de confirmación. |
| `deny` | La herramienta **no se anuncia**: el agente no la ve al listar y no puede planificar un borrado. Si la invoca igual, la llamada falla y no toca la base. |

El filtrado con `deny` ocurre en el listado y no solo en la ejecución, como pide
la sección 8.1: una herramienta visible que siempre falla hace que el agente
planifique acciones que no puede completar.

Un valor que no sea uno de esos tres impide el arranque del servidor con un
mensaje en stderr, en vez de caer en silencio al valor por defecto (sección
11.2). Con `MCP_DESTRUCTIVE_POLICY=denyy` creerías tener el borrado apagado y lo
tendrías encendido, solo que preguntando primero.

El borrado reindexa la columna dentro de la misma transacción, así que el orden
queda denso `0..n-1`; la respuesta trae el orden final completo de la columna
para que el agente no tenga que volver a listar.

### El primer tablero

F2.1 tiene tres herramientas —`list_tasks`, `create_task`, `move_task`— y
ninguna crea tableros: `create_board` llega en un paso posterior. Hace falta al
menos un tablero antes de que el agente pueda hacer nada, y por ahora se crea
por SQL, con las cuatro columnas por defecto de la sección 4.3:

```powershell
docker exec -i taskman-postgres psql -U taskman -d taskman -v ON_ERROR_STOP=1 -c @'
WITH nuevo AS (
  INSERT INTO board (id, name) VALUES (gen_random_uuid(), 'Personal') RETURNING id
)
INSERT INTO board_column (id, board_id, name, key, position)
SELECT gen_random_uuid(), nuevo.id, c.name, c.key, c.position
  FROM nuevo, (VALUES (0,'BACKLOG','Backlog'),(1,'TODO','Por hacer'),
                      (2,'IN_PROGRESS','En progreso'),(3,'DONE','Completado'))
              AS c(position, key, name);
'@
```

### Diagnóstico

El servidor escribe en stderr y nunca en stdout, que es el canal del protocolo.
Para ejecutarlo a mano y ver por qué no arranca:

```powershell
$env:MCP_PORT_MODE = "core"
$env:DATABASE_URL = "postgresql://taskman:taskman@127.0.0.1:5432/taskman?schema=public"
node .\apps\mcp-stdio\dist\index.js
```

Se queda esperando mensajes MCP por stdin; `Ctrl+C` lo corta.

## Estructura

| Paquete | Qué hay |
| --- | --- |
| `packages/db` | Esquema Prisma, migraciones y cliente. |
| `packages/core` | Servicios, repositorios, errores de dominio y el registro de herramientas MCP (`src/mcp`). |
| `apps/mcp-stdio` | Entrypoint stdio: monta el registro del núcleo sobre un `McpServer`. |

El registro de herramientas vive en `packages/core/mcp` y está declarado como
dato: el núcleo no importa el SDK de MCP (ver `CLAUDE.md`). Cada transporte lo
monta sobre su propio servidor, de modo que el catálogo no puede divergir entre
stdio y el futuro Streamable HTTP.
