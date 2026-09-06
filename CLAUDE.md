# TaskMan

Gestor de tareas Kanban personal con API REST y servidor MCP para agentes de IA.
Especificación completa en `docs/` (.docx, binarios: pedime el contenido, no
intentes leerlos).

## Estado

Fase F1a: fundación de datos. Todavía no existen servicios, API, MCP ni UI.

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

## Cómo trabajamos

- Un cambio lógico por vez. No agrupes cambios "de bajo riesgo".
- Si algo que encontrás en el repo contradice el prompt que recibiste, PARÁ y
  reportá antes de tocar nada.
- No instales dependencias globales sin avisar.
- Si te parece que hace falta salir del alcance del prompt para completarlo,
  PARÁ y explicá por qué antes de escribirlo.