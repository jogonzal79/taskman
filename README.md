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

Las once herramientas del catálogo de la sección 8.2, completo, sobre los dos
transportes de la 8.1 y, en el de stdio, sobre los dos modos que la tabla de esa
sección define:

| `MCP_PORT_MODE` | Cómo habla con los datos | Cuándo |
| --- | --- | --- |
| `core` (por defecto) | Los servicios corren en este mismo proceso y hablan con PostgreSQL directamente, sin pasar por HTTP. Pide `DATABASE_URL`. | Claude Code en la misma máquina que la base. |
| `http` | Un cliente de la API REST (`HttpPort`) con una API key. No toca la base y **no pide `DATABASE_URL`**. Pide `TASKMAN_API_URL` y `TASKMAN_API_KEY`. | Claude Code local contra un servidor, que la 8.1 llama el caso habitual. |

Cambiar de modo no cambia el catálogo ni lo que hace cada herramienta: es el
mismo registro del núcleo montado sobre otro puerto (ADR-003). Lo que sí cambia
es **cuántas herramientas se ven**, porque en `http` hay una clave y sus scopes
recortan el catálogo; más abajo, en su sección.

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

### Usarlo contra un servidor, por stdio (`MCP_PORT_MODE=http`)

El mismo proceso de arriba, pero hablando con la API REST en vez de con la base.
Es el escenario "Claude Code local contra servidor remoto" de la 8.1, y el
bloque `env` es el de la 8.6: `DATABASE_URL` no va, y en su lugar van la URL y
la clave.

```json
"taskman": {
  "command": "node",
  "args": ["./apps/mcp-stdio/dist/index.js"],
  "env": {
    "MCP_PORT_MODE": "http",
    "TASKMAN_API_URL": "http://localhost:3000",
    "TASKMAN_API_KEY": "tmk_live_PEGA_LA_CLAVE",
    "MCP_DESTRUCTIVE_POLICY": "confirm",
    "LOG_LEVEL": "info"
  }
}
```

La clave se emite igual que la de `/mcp`, y acá conviene con `--agent`:

```powershell
pnpm run apikey:create -- --agent "claude code por stdio" read write
```

`--agent` rotula la clave como `AGENT` en la auditoría de la 7.4, en vez del
`API` por defecto. Hace falta porque el borde REST **no puede ver** por dónde
entró una petición —la del `HttpPort` y la de `curl` son la misma en el cable—
así que el tipo de actor sale de la credencial, que la elige quien emite
(sección 7.4). Sin la bandera, todo lo que este servidor MCP escriba queda
auditado como `API`. La bandera va antes o después de la etiqueta, y los scopes
siguen siendo variádicos.

**Qué cambia respecto del modo `core`:**

- **El catálogo es el de la clave** (8.1). Con una clave `read write` se
  anuncian **diez** herramientas y `delete_task` no aparece: el filtrado ocurre
  en el listado y no sólo en la ejecución, para que el agente no planifique un
  borrado que no puede completar. Es el mismo comportamiento que ya tenía
  `/mcp`, que lee los scopes de la fila de la clave; acá no hay fila que leer
  —este proceso sólo tiene la clave en claro— así que se **miden** al arrancar
  con tres peticiones que no pueden tocar nada (`GET`, `PATCH` y `DELETE` sobre
  `/api/tasks/sonda-de-scope`, un id que no es un UUID y que los tres handlers
  rechazan con 400 antes de mirar la base). En el log del servidor se ven esas
  tres líneas cada vez que arranca un agente; no son un cliente roto.
- **La auditoría la escribe el servidor**, con el rótulo de la clave y su
  prefijo como `client_id`, y el `request_id` que queda en `audit_log` es el del
  servidor y no uno que elija este proceso.
- **Rige el límite de la 7.3**, que se cobra por clave: 120 lecturas y 30
  escrituras por minuto, compartido con todo lo que use esa misma clave.

**Si no arranca**, el motivo sale en stderr y el proceso termina con código 1
(sección 11.2), que es lo que Claude Code muestra como servidor `failed`:

| Mensaje en stderr | Qué pasó |
| --- | --- |
| `TASKMAN_API_URL: falta` o `TASKMAN_API_KEY: falta` | Falta una de las dos del bloque `env`. El mensaje las lista todas juntas, no de a una por reinicio. |
| `TASKMAN_API_URL="…": se esperaba una URL absoluta http:// o https://` | Una URL sin esquema, o con uno que no sirve. Se valida al arrancar y no en la primera llamada. |
| `rechazo la clave con 401: revisa TASKMAN_API_KEY` | La clave no existe, está revocada o la borró un `verify`. Arrancar igual daría once herramientas que fallan las once. |

Si el servidor **no responde** —está apagado, o la URL apunta a otro lado— el
arranque no falla: los scopes no se pueden medir, se dan por concedidos, queda
una línea `mcp.scopes` de nivel `warn` diciendo cuáles, y el catálogo sale
completo. El agente se entera al primer intento, con el error de esa llamada.

### Usarlo como cliente remoto, por HTTP (`/mcp`)

La app web sirve el mismo catálogo por Streamable HTTP en `/mcp` (sección 8.1),
autenticado con una API key igual que `/api`: la clave va como
`Authorization: Bearer` y sus scopes (7.2) deciden qué herramientas se ofrecen.
Probado con Claude Code 2.1.273.

> **Cada `pnpm run verify` BORRA las claves.** La suite trunca `api_key`, así
> que después de un `verify` la clave configurada deja de existir y Claude Code
> falla con 401. Hay que emitir otra y volver a registrar el servidor (paso 3,
> con `claude mcp remove taskman-remoto` antes). Es lo primero que confunde.

**1. Levantar la app** en esta máquina y comprobar que responde:

```powershell
pnpm run db:up
pnpm --filter @taskman/web run build
pnpm --filter @taskman/web run start          # http://localhost:3000
curl.exe http://localhost:3000/api/health     # tiene que dar 200
```

**2. Emitir la clave**, con `read` y `write`: es lo que la 7.2 recomienda para
un agente. Se muestra una sola vez.

```powershell
pnpm run apikey:create -- "claude code remoto" read write
```

Acá `--agent` no hace falta y por eso no está: `/mcp` **sí** ve por dónde entró
la petición y audita `AGENT` por construcción, mire lo que mire la clave. La
bandera es para el modo `http` por stdio, donde lo que entra es una petición
REST indistinguible de un `curl` (ver la sección anterior).

**3. Registrar el servidor en Claude Code**, desde la raíz del repo:

```powershell
claude mcp add --transport http --scope local taskman-remoto http://localhost:3000/mcp --header "Authorization: Bearer tmk_live_PEGA_LA_CLAVE"
```

- `--scope local` guarda la configuración en `~/.claude.json`, solo para este
  proyecto: la clave no llega nunca a un archivo del repo.
- Se llama `taskman-remoto` para convivir con el `taskman` por stdio del
  `.mcp.json`. Las herramientas se distinguen por el prefijo:
  `mcp__taskman-remoto__move_task` contra `mcp__taskman__move_task`.

La misma entrada en JSON, por si se prefiere un archivo de configuración:

```json
"taskman-remoto": {
  "type": "http",
  "url": "http://localhost:3000/mcp",
  "headers": { "Authorization": "Bearer tmk_live_PEGA_LA_CLAVE" }
}
```

**4. Comprobar que conectó:**

- `claude mcp get taskman-remoto` lo muestra conectado.
- Dentro de una sesión, `/mcp` muestra `taskman-remoto` con **diez**
  herramientas: `delete_task` no aparece porque la clave no tiene `delete`.
- "Listá los tableros con taskman-remoto" tiene que llamar a `list_boards`.
- En la salida de `pnpm --filter @taskman/web run start` aparece una línea por
  petición con `"route":"/mcp"`, `"client_id":"tmk_live_…"` y
  `"actor_type":"AGENT"`. Al conectar, Claude Code manda primero un POST de
  sondeo que recibe **400**: no es un error, el `initialize` que sigue da 200.

#### Si no conecta

| Lo que muestra Claude Code | Qué pasó | Qué hacer |
| --- | --- | --- |
| `failed`, con "Server rejected the configured Authorization header (HTTP 401)" | La clave no existe, está revocada o la borró un `verify`. Con la cabecera configurada, Claude Code no intenta OAuth. | Emitir otra, `claude mcp remove taskman-remoto` y volver al paso 3. |
| `failed`, con "Dynamic Client Registration rejected (HTTP 404)" seguido de HTML | **La configuración no tiene la cabecera.** Sin `Authorization`, Claude Code intenta OAuth, el registro dinámico de cliente no existe y Next responde con su página 404. El mensaje **no** dice que falta la clave. | Volver a registrar con `--header "Authorization: Bearer …"`. |
| Una llamada que falla con 429 `RATE_LIMITED` | El cupo de la 7.3 por clave: 120 lecturas y 30 escrituras por minuto, compartido con `/api`. Cada `tools/call` cobra el cupo de su herramienta. | Esperar lo que dice `Retry-After`. Mover más de 30 tareas en un minuto exige pausar. |

#### Las once herramientas: solo en una prueba supervisada

Con `read write` se ven diez. `delete_task` exige una clave con `delete`, y la
7.2 recomienda no dársela a un agente autónomo. Para comprobar las once, emitir
una clave aparte, registrarla, probar y sacarla:

```powershell
pnpm run apikey:create -- "prueba delete supervisada" read write delete
claude mcp remove taskman-remoto
claude mcp add --transport http --scope local taskman-remoto http://localhost:3000/mcp --header "Authorization: Bearer tmk_live_LA_CLAVE_CON_DELETE"
# ... la prueba ...
claude mcp remove taskman-remoto
# Revocar se hace por SQL (7.1); usuario y base son los POSTGRES_* del .env.
docker compose exec postgres psql -U taskman -d taskman -c "UPDATE api_key SET revoked_at = now() WHERE label = 'prueba delete supervisada'"
```

Después volver a registrar la clave de `read write`. La revocada sigue
autenticando hasta 60 s por el cache de claves de la 7.1; reiniciar la app la
corta en el acto. El borrado sigue la `MCP_DESTRUCTIVE_POLICY` del `.env`, que
por defecto es `confirm`.

#### Desde otra máquina de la red: no

Conectarse a `/mcp` desde otra máquina es justo el disparador del desvío "La UI
no tiene autenticación" de `CLAUDE.md`. Si el puerto es alcanzable desde la
red, también lo es la UI, que lee y escribe todo **sin clave**, y la clave de
`/mcp` viaja en **texto plano**, porque no hay TLS. Y hoy nada lo impide del
lado de la app: `next start` escucha en todas las interfaces (medido: anuncia
una dirección de red además de `localhost`), así que el único resguardo es el
firewall del sistema. Usarlo en la misma máquina, con `localhost`.

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
| `mcp.ready` | Al arrancar | `mode`, `transport`, `scopes`, `destructivePolicy`, `logLevel` |
| `mcp.scopes` | Sólo en modo `http`, y sólo si algún scope no se pudo medir | `scopes` y `undetermined`: los que se dan por concedidos sin haberlos medido, o sea las herramientas que el catálogo puede tener de más |
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
stdio y el Streamable HTTP de `/mcp`.
