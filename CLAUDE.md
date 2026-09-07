# TaskMan

Gestor de tareas Kanban personal con API REST y servidor MCP para agentes de IA.
Especificación completa en `docs/*.md`: son la conversión legible de los
originales y son la fuente que tenés que consultar. Los `.docx` del mismo
directorio son ese original binario; no intentes leerlos.

## Estado

Construido y verificado: packages/db (esquema, migracion inicial, restricciones)
y packages/core (errores de dominio, normalizador de errores de base, repositorio
de tareas y TaskService.move). 24 pruebas de integracion contra PostgreSQL real.

Todavia NO existen: el resto del CRUD de tareas, boards, columnas, auditoria,
packages/contracts, la API REST, el servidor MCP ni la UI.

Fase en curso: F1b.2 — resto del CRUD de tareas sobre packages/core.

## Entorno

- Windows 11, PowerShell. La ruta del proyecto contiene un espacio: entrecomillá
  cualquier ruta en scripts y configuración.
- Node 20+, pnpm workspaces, TypeScript strict con noUncheckedIndexedAccess.
- PostgreSQL 16 en Docker Desktop.
- Los scripts de package.json deben ser multiplataforma: nada de `rm`, `cp`,
  `export` ni here-docs.

## Reglas que no se negocian

- Nunca `prisma db push`. Solo `prisma migrate dev` / `prisma migrate deploy`.
- Las restricciones `UNIQUE ... DEFERRABLE` sobre `position` se declaran SOLO en
  SQL crudo dentro de la migración. No las declares como `@@unique` en
  `schema.prisma`: Prisma generaría una versión no diferible.
- La FK `task → board_column` es `ON DELETE NO ACTION`, no `RESTRICT`. RESTRICT
  se evalúa fila a fila y rompe el borrado en cascada de un tablero.
- Los UUID los genera la aplicación, no la base.
- El orden de tareas es entero denso 0..n-1 por columna, sin huecos. Toda
  operación que altere el orden reescribe la secuencia completa dentro de una
  transacción.
- (A partir de F1b) `packages/core` no importa Next, ni el SDK de MCP, ni nada
  de HTTP. Los adaptadores (REST, MCP) no contienen reglas de negocio. Ningún
  adaptador importa Prisma directamente.
- Los errores de PostgreSQL llegan por dos caminos distintos segun donde
  falle la sentencia, y hay que cubrir los dos. Si la viola una sentencia
  concreta, Prisma la envuelve en un `PrismaClientKnownRequestError` y la
  causa del driver queda en `meta.driverAdapterError.cause`. Si la viola el
  COMMIT (caso tipico de una restriccion diferida), Prisma no la envuelve:
  escapa un `DriverAdapterError` crudo, sin `code` ni `meta`, con la causa en
  `error.cause`. El payload de la causa es identico en ambos casos; lo unico
  que cambia es la clase del error y donde cuelga.
- En SQL crudo, los parametros UUID necesitan casteo explicito
  (`WHERE column_id = ${id}::uuid`). El adapter los bindea como texto y
  PostgreSQL no compara `uuid = text`.
- `expectDbFailure()` de `packages/db/test/helpers.ts` solo sirve para errores
  del camino `pg` directo: busca el SQLSTATE en `error.code`, donde Prisma
  pone otra cosa o nada. No lo uses para errores que vengan por Prisma.
- El bloqueo de filas para mover una tarea se hace en UNA sola sentencia, que
  resuelve la columna origen por subquery y bloquea con `FOR UPDATE` las filas
  de ambas columnas ordenadas por `(column_id, id)`. Nunca un `FOR UPDATE`
  previo sobre la tarea: ese lock queda fuera del orden canonico y produce
  deadlock 40P01 en movimientos cruzados A->B y B->A. Verificado
  empiricamente reintroduciendo el bloqueo previo: 40P01 a los ~1.2 s, el
  `deadlock_timeout` de PostgreSQL.
- Se ordena por `id`, no por `position`. `position` es justamente lo que la
  transaccion muta, asi que dos snapshots distintos recorrerian la misma
  columna en ordenes distintos y el interbloqueo reaparece dentro de una sola
  columna. `id` no cambia nunca.
- Se reintenta ante 40001 y ante violacion de `task_column_position_uniq`:
  las dos son contencion legitima, y el tope es el mismo, dos reintentos.
  Sobre una columna vacia no hay filas que bloquear, asi que dos operaciones
  simultaneas calculan la misma position sin verse y la restriccion diferida
  las separa recien en el COMMIT. Solo esa restriccion por nombre: cualquier
  otra unicidad es un error real.
- No se reintenta NUNCA ante 40P01. Un interbloqueo significa que el orden de
  bloqueo esta mal, y reintentarlo esconde el bug que detecta la prueba C2 de
  `packages/core` en vez de arreglarlo.

## Cómo trabajamos

- Un cambio lógico por vez. No agrupes cambios "de bajo riesgo".
- Si algo que encontrás en el repo contradice el prompt que recibiste, PARÁ y
  reportá antes de tocar nada.
- No instales dependencias globales sin avisar.
- Si te parece que hace falta salir del alcance del prompt para completarlo,
  PARÁ y explicá por qué antes de escribirlo.

## Normalizador de errores de base (del spike F1b.0)

Material de referencia para cuando se escriban los errores de dominio. **No es
codigo en uso**: el spike que lo produjo esta borrado. Sirve como punto de
partida porque cubre las dos ramas descritas arriba.

```ts
function describirFalla(error: unknown): Falla {
  const e = error as { code?: unknown; meta?: Record<string, unknown>; message?: unknown; cause?: unknown };
  const message = String(e?.message ?? error);
  const prismaCode = typeof e?.code === "string" ? e.code : undefined;
  const ctor = (error as object)?.constructor?.name ?? typeof error;

  // Prisma 7 no aplana el error del driver: lo anida. Hay DOS caminos segun
  // como falle, y hay que mirar los dos.
  //   - Error atribuido a una sentencia: PrismaClientKnownRequestError, con el
  //     detalle en meta.driverAdapterError.cause.
  //   - Error del COMMIT: DriverAdapterError pelado, con el detalle en .cause.
  const meta = e?.meta ?? {};
  const anidado = meta["driverAdapterError"] as { cause?: unknown } | undefined;
  const causa = (anidado?.cause ?? e?.cause) as Record<string, unknown> | undefined;

  const leer = (clave: string): string | undefined =>
    typeof causa?.[clave] === "string" ? (causa[clave] as string) : undefined;

  const indice = (causa?.["constraint"] as { index?: unknown } | undefined)?.index;

  return {
    ctor,
    prismaCode,
    kind: leer("kind"),
    sqlState: leer("originalCode"),
    constraint: typeof indice === "string" ? indice : undefined,
    constraintEnMensaje: message.includes("task_column_position_uniq"),
    causa,
    message,
  };
}
```