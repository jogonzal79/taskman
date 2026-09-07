# TaskMan

Gestor de tareas Kanban personal con API REST y servidor MCP para agentes de IA.

Especificación en `docs/`:
- Documento Técnico-Funcional v1.0
- Especificación Técnica de Desarrollo v1.0

Estado: F2.3 — servidor MCP por stdio con el catálogo completo de la sección 8.2.

## Puesta en marcha

```powershell
Copy-Item .env.example .env    # solo la primera vez
pnpm install
pnpm run verify                # levanta la base, migra, compila y corre las pruebas
```

`verify` deja construido `apps/mcp-stdio/dist/index.js`, que es lo que arranca
el servidor MCP.

## Servidor MCP

Las once herramientas del catálogo de la sección 8.2, completo, sobre el
transporte stdio de la 8.1 en modo `core`: los servicios corren en el mismo
proceso y hablan con PostgreSQL directamente, sin pasar por HTTP. El modo `http`
de la 8.1 todavía no existe y el servidor falla al arrancar si se lo pide.

| Entidad | Herramientas |
| --- | --- |
| Tableros | `list_boards`, `get_board`, `create_board` |
| Columnas | `create_column` |
| Tareas | `list_tasks`, `search_tasks`, `get_task`, `create_task`, `update_task`, `move_task`, `delete_task` |

`delete_task` es la única destructiva y tiene su propia política, más abajo. No
hay borrado masivo, y es a propósito (sección 8.3.3): enumerar con `list_tasks`
y borrar de a una hace que el alcance sea visible antes de actuar y que un fallo
parcial sea reparable elemento a elemento.

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

Todas resuelven tableros, columnas y tareas por nombre además de por id, así que
"creá 'Revisar HU-25' en TODO del tablero QA" es una sola llamada. Si un nombre
es ambiguo, la herramienta devuelve `AMBIGUOUS_MATCH` con los candidatos y no
elige: hay que desambiguar.

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

Ya no hace falta sembrarlo por SQL: `create_board` está en el catálogo, así que
"creá un tablero Personal" alcanza. Sin columnas indicadas se crean las cuatro
por defecto de la sección 4.3 —`BACKLOG`, `TODO`, `IN_PROGRESS`, `DONE`—, que es
lo que espera el resto de las herramientas.

### Diagnóstico

El servidor escribe en stderr y nunca en stdout, que es el canal del protocolo.
Lo que escribe es log estructurado en JSON, una línea por evento (sección 11.1):

| `evt` | Cuándo | Campos propios |
| --- | --- | --- |
| `mcp.ready` | Al arrancar | `mode`, `transport`, `destructivePolicy`, `logLevel` |
| `mcp.tool` | Una por invocación de herramienta | `tool`, `durationMs`, `outcome` (`ok`, `domain_error`, `error`) y `code` solo si hubo error de dominio |
| `mcp.resolve` | Una por resolución por nombre (sección 8.3.1) | `entity`, `strategy` (`uuid`, `exact`, `partial`), `matches` y `resolvedId` solo si hubo exactamente una |
| `mcp.resolve.ref` | Igual que la anterior, pero solo en `debug` | `reference`: el texto crudo que mandó el agente, que para una tarea es su título |

Todas llevan `requestId`, y es **el mismo** que queda en la columna `request_id`
de `audit_log`: con él se cruza lo que pidió un agente, cómo se resolvió y qué
escribió. Las de `mcp.tool` llevan además `actorType` y `actorName`.

`LOG_LEVEL` controla el detalle: `debug`, `info` (por defecto), `warn` o
`error`. Un valor fuera de esos cuatro impide el arranque, igual que
`MCP_DESTRUCTIVE_POLICY`: quien escribió `LOG_LEVEL=verbose` está buscando un
problema, y arrancar en `info` le daría menos líneas de las que cree tener.

Para ejecutarlo a mano, con cada canal en su archivo y una llamada real:

```powershell
$raiz = "C:\Users\Jonathan Gonzalez\Documents\taskman"
$tmp  = Join-Path $env:TEMP "taskman-mcp"
New-Item -ItemType Directory -Force $tmp | Out-Null

# initialize, initialized y una llamada a list_boards.
$mensajes = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"powershell","version":"0.0.0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}'
)
[IO.File]::WriteAllLines((Join-Path $tmp "entrada.jsonl"), $mensajes)

$env:MCP_PORT_MODE = "core"
$env:DATABASE_URL  = "postgresql://taskman:taskman@127.0.0.1:5432/taskman?schema=public"
$env:MCP_DESTRUCTIVE_POLICY = "confirm"
$env:LOG_LEVEL = "debug"

Start-Process -FilePath "node" -ArgumentList "`"$raiz\apps\mcp-stdio\dist\index.js`"" `
  -RedirectStandardInput  (Join-Path $tmp "entrada.jsonl") `
  -RedirectStandardOutput (Join-Path $tmp "stdout.jsonl") `
  -RedirectStandardError  (Join-Path $tmp "stderr.jsonl") `
  -NoNewWindow -Wait

Get-Content (Join-Path $tmp "stdout.jsonl")   # solo JSON-RPC
Get-Content (Join-Path $tmp "stderr.jsonl")   # solo log
```

`stdout.jsonl` tiene que traer únicamente respuestas JSON-RPC. Si aparece ahí
una línea de log, el canal del protocolo está contaminado y el cliente la recibe
como si fuera un mensaje: es exactamente lo que verifica `test/log.test.ts`.
Sin el archivo de entrada, el servidor se queda esperando mensajes por stdin y
`Ctrl+C` lo corta.

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
