# AI-Agent Friendly Task Management System

**Documento Técnico-Funcional — Versión 1.0**

Gestor personal tipo Kanban/Trello con API y MCP para interacción mediante agentes de IA

# 1. Resumen ejecutivo

Se propone construir una aplicación web personal de gestión de tareas, inspirada en Trello, cuyo diferencial principal será que el sistema no estará diseñado únicamente para interacción humana. Desde el inicio, sus operaciones estarán expuestas mediante una API y una interfaz MCP (Model Context Protocol), permitiendo que agentes como Claude Code CLI, Codex CLI u otras herramientas compatibles puedan consultar y modificar tableros, tareas y estados de forma controlada.

La interfaz web será un cliente del mismo backend que utilizarán los agentes. Esto evita crear una lógica paralela para humanos y para IA y convierte al sistema en una fuente única de verdad.

# 2. Objetivos

- Disponer de un gestor personal de tareas tipo Kanban/Trello.

- Permitir crear, consultar, editar, eliminar y mover tareas entre columnas.

- Permitir múltiples tableros y proyectos sin introducir complejidad innecesaria en el MVP.

- Exponer todas las operaciones relevantes mediante una API bien definida.

- Exponer las operaciones mediante MCP para que agentes de IA puedan ejecutar acciones.

- Mantener una arquitectura desacoplada entre frontend, servicios de negocio, API/MCP y base de datos.

- Priorizar seguridad, trazabilidad y operaciones predecibles para agentes.

# 3. Alcance del MVP

| Área | Incluido | Fuera de alcance inicial |
| --- | --- | --- |
| Usuarios | 1 usuario | Multiusuario avanzado |
| Tableros | Crear, listar, editar | Compartición y permisos complejos |
| Columnas | CRUD y orden | Automatizaciones complejas |
| Tareas | CRUD completo | Dependencias avanzadas |
| Movimiento | Drag & drop + API/MCP | Workflows complejos |
| Campos | Título, descripción, prioridad, fecha, posición | Campos personalizados |
| Agentes | REST API + MCP | Marketplace de agentes |
| Auditoría | Registro básico de cambios | Analítica avanzada |

# 4. Concepto funcional

El sistema tendrá como unidad visual principal un tablero Kanban. Un tablero contiene columnas y cada columna contiene tareas. Una tarea pertenece a un tablero y a una columna y tiene una posición que determina su orden.

Estados iniciales recomendados:

- BACKLOG

- TODO / POR HACER

- IN PROGRESS / EN PROGRESO

- DONE / COMPLETADO

# 5. Principios de arquitectura

- API-first: las operaciones de negocio deben poder ejecutarse sin depender de la UI.

- Single source of truth: frontend y agentes consultan/modifican el mismo backend.

- Service layer: REST y MCP llaman a servicios de negocio comunes; ninguno accede directamente a la base de datos.

- Agent-safe by design: herramientas explícitas, validaciones, permisos y respuestas estructuradas.

- Idempotencia cuando aplique, especialmente en operaciones de actualización.

- Trazabilidad: registrar quién/qué cliente ejecutó una operación y cuándo.

# 6. Arquitectura propuesta

Arquitectura lógica:

```
Web UI (Next.js/React)
        ↓
Backend / API
        ↓
Service Layer
        ├── BoardService
        ├── ColumnService
        └── TaskService
        ↓
PostgreSQL

MCP Server ───────────────→ Service Layer
REST Clients / Scripts ──→ API
```

# 7. Modelo de datos

## 7.1 Board

- id (UUID)

- name

- description

- created_at

- updated_at

## 7.2 Column

- id (UUID)

- board_id

- name

- key

- position

- created_at

- updated_at

## 7.3 Task

- id (UUID)

- board_id

- column_id

- title

- description

- priority (LOW/MEDIUM/HIGH/URGENT)

- due_date

- position

- created_at

- updated_at

## 7.4 AuditLog

- id

- actor_type (USER/AGENT/API)

- actor_name/client_id

- action

- entity_type

- entity_id

- before_data

- after_data

- created_at

# 8. Requisitos funcionales

| ID | Funcionalidad | Criterio |
| --- | --- | --- |
| RF-01 | Crear tablero | El usuario o agente debe poder crear un tablero indicando nombre y descripción opcional. |
| RF-02 | Crear columnas | Debe ser posible crear columnas y establecer su posición. |
| RF-03 | Crear tarea | Debe ser posible crear una tarea con título, descripción opcional, prioridad, fecha y columna. |
| RF-04 | Consultar tareas | Debe ser posible listar tareas por tablero, columna, prioridad y otros filtros básicos. |
| RF-05 | Actualizar tarea | Debe ser posible modificar cualquier campo editable de una tarea. |
| RF-06 | Eliminar tarea | Debe ser posible eliminar una tarea mediante UI, API o MCP. |
| RF-07 | Mover tarea | Una tarea debe poder moverse entre columnas y cambiar de posición. |
| RF-08 | Ordenar tareas | El orden visual debe persistirse mediante position. |
| RF-09 | Buscar | Debe ser posible buscar tareas por título/descripción. |
| RF-10 | Auditar | Las acciones realizadas por agentes/API deben poder registrarse. |

# 9. API REST propuesta

| Método | Endpoint | Uso |
| --- | --- | --- |
| GET | /api/boards | Listar tableros |
| POST | /api/boards | Crear tablero |
| GET | /api/boards/{id} | Consultar tablero |
| PATCH | /api/boards/{id} | Actualizar tablero |
| DELETE | /api/boards/{id} | Eliminar tablero |
| POST | /api/boards/{id}/columns | Crear columna |
| PATCH | /api/columns/{id} | Actualizar/mover columna |
| DELETE | /api/columns/{id} | Eliminar columna |
| GET | /api/tasks | Listar/buscar tareas |
| POST | /api/tasks | Crear tarea |
| GET | /api/tasks/{id} | Consultar tarea |
| PATCH | /api/tasks/{id} | Actualizar tarea |
| DELETE | /api/tasks/{id} | Eliminar tarea |
| POST | /api/tasks/{id}/move | Mover tarea |

# 10. MCP para agentes de IA

MCP será una capa de integración sobre los servicios de negocio. El objetivo es que un agente no tenga que conocer detalles internos de SQL o endpoints HTTP, sino operar mediante herramientas semánticas.

**list_boards —** Consultar tableros disponibles.

**get_board —** Obtener estructura de un tablero.

**create_board —** Crear un tablero.

**list_tasks —** Listar tareas con filtros.

**search_tasks —** Buscar tareas por texto.

**get_task —** Consultar una tarea.

**create_task —** Crear una tarea.

**update_task —** Actualizar campos de una tarea.

**move_task —** Mover una tarea a otra columna/posición.

**delete_task —** Eliminar una tarea.

**create_column —** Crear una columna.

# 11. Ejemplos de interacción con agentes

**Crear:** Crea una tarea llamada 'Revisar HU-25' en el tablero QA y colócala en TODO.

**Mover:** Mueve 'Revisar HU-25' a IN PROGRESS.

**Actualizar:** Pon 'Revisar HU-25' con prioridad alta y fecha límite el viernes.

**Consultar:** Muéstrame todas las tareas pendientes del tablero EPX.

**Operación masiva:** Mueve a TODO todas las tareas de EPX-25 que estén en BACKLOG.

# 12. Seguridad

- El MVP puede utilizar una API Key de servicio para clientes externos.

- Las claves deben almacenarse de forma segura y nunca persistirse en texto plano si existe almacenamiento de credenciales.

- Cada operación debe validar que el recurso pertenece al tablero autorizado.

- Eliminar recursos puede requerir confirmación explícita en las herramientas MCP o un modo de operación configurable.

- Las operaciones destructivas deben quedar registradas en AuditLog.

- No se debe exponer directamente PostgreSQL al agente.

# 13. Requisitos no funcionales

- API REST documentada mediante OpenAPI.

- Respuestas JSON consistentes y con códigos HTTP apropiados.

- Validación de entrada mediante esquema.

- Identificadores UUID.

- Persistencia transaccional para movimientos y cambios de posición.

- Pruebas unitarias para servicios y pruebas de integración para API/MCP.

- Errores legibles para humanos y estructurados para agentes.

- Diseño responsive para uso personal en desktop y móvil.

# 14. Reglas importantes para agentes

- No asumir IDs: primero consultar y resolver recursos por nombre cuando sea necesario.

- Si existen varias tareas con el mismo nombre, el agente debe solicitar desambiguación.

- No crear duplicados cuando la intención sea actualizar una tarea existente.

- Antes de operaciones masivas destructivas, el agente debe resumir el alcance y pedir confirmación si la política del cliente lo requiere.

- Las herramientas deben devolver identificadores, estado final y errores accionables.

- El backend debe ser la autoridad final sobre estados, permisos y relaciones.

# 15. UX del tablero

La interfaz debe priorizar simplicidad. El usuario podrá arrastrar tarjetas entre columnas, abrir una tarjeta para editarla, crear tareas rápidamente y filtrar el tablero.

- Header con nombre del tablero y acciones.

- Columnas horizontales con scroll.

- Tarjetas con título, prioridad y fecha.

- Drag & drop persistente.

- Modal/panel lateral para detalle de tarea.

- Acciones rápidas: editar, mover, eliminar.

- Indicadores visuales para tareas vencidas o de alta prioridad.

# 16. Stack tecnológico recomendado

| Componente | Tecnología |
| --- | --- |
| Frontend | Next.js + React + TypeScript + Tailwind CSS |
| Drag & Drop | Librería moderna de DnD para React |
| Backend | Next.js API/Route Handlers o servicio Node.js independiente |
| DB | PostgreSQL |
| ORM | Prisma o Drizzle |
| Validación | Zod |
| API Docs | OpenAPI/Swagger |
| Agent Interface | MCP Server |
| Deployment inicial | Docker + plataforma sencilla o servidor personal |

# 17. Roadmap

**Fase 1 — Fundación:** Repositorio, arquitectura, PostgreSQL, migraciones, Board/Column/Task y service layer.

**Fase 2 — API:** CRUD REST completo, validación, OpenAPI y autenticación por API key.

**Fase 3 — Web UI:** Kanban, CRUD visual, drag & drop y filtros.

**Fase 4 — MCP:** Servidor MCP, herramientas de lectura y escritura, manejo de errores y seguridad.

**Fase 5 — Agent hardening:** Idempotencia, desambiguación, operaciones masivas, auditoría y pruebas con Claude/Codex.

**Fase 6 — Evolución:** Etiquetas, checklists, subtareas, recurrencia, calendario y automatizaciones.

# 18. Criterios de aceptación del MVP

- Se puede crear un tablero y sus columnas desde la UI.

- Se pueden crear, editar y eliminar tareas.

- Una tarea puede moverse mediante drag & drop y el cambio persiste al recargar.

- La API permite ejecutar todas las operaciones CRUD principales.

- Un cliente autenticado puede consumir la API sin utilizar la UI.

- Claude Code u otro cliente MCP compatible puede listar, crear, actualizar, eliminar y mover tareas.

- Una operación realizada por API/MCP se refleja inmediatamente en la UI.

- Las operaciones críticas generan registros de auditoría.

- Los errores son suficientemente descriptivos para que un agente pueda corregir o solicitar aclaración.

# 19. Evoluciones futuras

- Subtareas y checklists.

- Dependencias entre tareas.

- Etiquetas y campos personalizados.

- Tareas recurrentes.

- Calendario.

- Webhooks para notificar a agentes externos.

- Event-driven architecture.

- OAuth para múltiples agentes/clientes.

- Permisos por tablero.

- Integraciones con GitHub, Slack, correo y calendarios.

- Historial de actividad visible en cada tarea.

- API pública versionada.

# 20. Decisión arquitectónica principal

La aplicación debe concebirse como un sistema de gestión de tareas con una interfaz web, no como una aplicación web que posteriormente recibe una integración de IA. La API y la capa de servicios son el núcleo. MCP se incorpora como una interfaz de agente sobre ese núcleo.

Esto permite que Claude Code, Codex u otros agentes actúen sobre el mismo sistema que utiliza el usuario, sin acoplar el producto a un proveedor específico de IA.
