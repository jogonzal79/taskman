# TaskMan

Gestor de tareas Kanban personal con API REST y servidor MCP para agentes de IA.
Especificación completa en `docs/*.md`: son la conversión legible de los
originales y son la fuente que tenés que consultar. Los `.docx` del mismo
directorio son ese original binario; no intentes leerlos.

## Estado

Acá NO hay inventario, y es a propósito. Un contador de pruebas y una lista de
endpoints caducan en cada commit, ningún paso tiene motivo para volver a
tocarlos, y entonces mienten por defecto: la lista de endpoints quedó vieja tres
veces seguidas, y las tres anunció como faltante algo que ya estaba construido.
Si estás por escribir acá un número o una enumeración de lo que ya existe, lo que
hace falta es el comando que lo averigua, no el dato.

- **Cuántas pruebas hay y si pasan**: `pnpm run verify`. Levanta la base, migra y
  corre las suites contra PostgreSQL real; cada paquete imprime su total.
- **Qué endpoints existen**, con su verbo y su scope, uno por línea:

  ```
  grep -rnE "^export (const|async function) (GET|POST|PATCH|PUT|DELETE)" apps/web/app --include=route.ts
  ```

  El `conAuth("…")` de cada línea es el scope que ese endpoint exige (7.2).
  `/api/health` sale sin `conAuth` porque es el único sin autenticación (6.2), y
  eso es TODO lo que lo hace distinto: no tiene 401, 403 ni el 429 de la 7.3, que
  se cobra por clave. El X-Request-Id SÍ lo lleva, como toda respuesta (6.1);
  genera el suyo con la misma `nuevoRequestId()` que usa `conAuth`.
- **Qué endpoints faltan**: la tabla de la 6.2 es el objetivo y el comando de
  arriba es el estado; la resta de los dos es la lista. Cualquier copia escrita
  acá empieza a envejecer el mismo día.
- **Qué herramientas MCP hay**: un archivo por herramienta en
  `packages/core/src/mcp/tools/`, montadas en `registry.ts`. El catálogo que
  tienen que cubrir es el de la 8.2.
- **En qué rama y fase estás**: `git branch --show-current` y `git log --oneline`.
  Los nombres de fase (F1b, F3, F4…) salen del plan de la 12.

Lo que no caduca está en las secciones de abajo, que son las que valen: la deuda
conocida, las trampas del entorno, las reglas que no se negocian y los
invariantes del servidor MCP.

## Deuda conocida

Salio del uso real, no de la especificacion. Ninguna esta arreglada; anotarlas
aca es para que no se redescubran de cero.

Esta lista SÍ va escrita a mano, a diferencia del inventario de arriba, y la
diferencia no es el formato: una entrada de acá se borra en el mismo commit que
arregla lo que describe, así que el trabajo que la invalida es el que la toca. Un
contador de pruebas no tiene ese commit.

- `ubicarTarea` no verifica que un id de tarea pertenezca al `board` indicado:
  la resolucion por id no busca, asi que un id valido de OTRO tablero se acepta.
  Afecta a `get_task` y a `update_task`. `delete_task` lo compensa recargando el
  tablero real de la tarea antes de armar la confirmacion, porque ahi mostrar el
  tablero equivocado y ninguna columna es peor que no confirmar. El arreglo de
  fondo va en `ubicarTarea`, para las tres a la vez.
- La busqueda full-text en espanol matchea PALABRAS COMPLETAS: `auth` no
  encuentra "autenticacion". Es como funciona `to_tsvector('spanish', ...)`, no
  un bug del query. La salida es `pg_trgm` en una migracion aditiva, sin tocar
  el indice que ya existe.
- Los ACENTOS no se normalizan de forma uniforme, y eso no se deduce leyendo el
  query: depende de la palabra. Si la forma acentuada solo pierde el acento, los
  dos lados convergen y se encuentran —"revisión" y "revision" dan los dos
  `revision`, "código" y "codigo" dan `codig`—. Pero si el acento dispara una
  regla del stemmer, NO convergen: "aceptación" da `acept` porque reconoce el
  sufijo -ación y lo quita, mientras "aceptacion" sin tilde da `aceptacion`. Son
  lexemas distintos, asi que buscar "aceptacion" NO encuentra "aceptación". Lo
  mismo con "documentación"/"documentacion" y "validación"/"validacion". O sea
  que la insensibilidad a acentos que se ve en algunos casos es ACCIDENTAL y no
  una garantia: no hay `unaccent` en el pipeline. La salida es `unaccent` en la
  CONFIGURACION de busqueda —una configuracion propia que encadene unaccent con
  el stemmer, y el indice de la 4.2 reconstruido sobre ella— y NO un cambio en el
  query, que es donde uno lo buscaria primero. Consecuencia de producto, para
  cuando se escriba la UI: sin eso, un buscador libre donde la gente tipea sin
  tildes se lee como roto; y la busqueda incremental mientras se escribe no es
  viable de entrada, porque `plainto_tsquery` no agrega `:*` y un prefijo no
  matchea (ver la entrada de arriba).
- Un parametro de consulta DESCONOCIDO se ignora en silencio en los CINCO
  endpoints de listado (GET /api/boards, GET /api/tasks, GET /api/tasks/search,
  GET /api/audit y el listado por columna). No es que el `strictObject` lo
  acepte: es que nunca lo ve, porque el handler arma el objeto a validar leyendo
  SOLO los parametros que conoce, uno por uno. Lo peligroso no es el 200 sino
  creer que el parametro acoto cuando quedo INERTE: `?column_key=TODO` en la
  busqueda devuelve el tablero entero, y quien lo mando no se entera. Esta atado
  con un test que afirma justamente eso. Cambiarlo —comparar las claves
  recibidas contra las declaradas y devolver 400— afecta a los cinco endpoints a
  la vez, asi que es su propio paso y no un arreglo al pasar.
- `list_boards` y `list_tasks` devuelven `has_more` pero no el `cursor` (y
  `search_tasks` tiene el mismo hueco). El nucleo lo tiene —`Page.nextCursor`, y
  las herramientas lo leen para calcular `has_more`— pero lo descartan al
  proyectar: el agente sabe que hay mas y no tiene con que pedirlo.
- `aFecha` (`packages/core/src/mcp/tools/campos.ts`) acepta dias que no existen.
  Valida el formato con una regex y despues con `Number.isNaN`, y eso NO alcanza:
  `new Date("2026-02-30T00:00:00.000Z")` no da invalida, se corre sola al 2 de
  marzo. O sea que hoy, por MCP, un `due_date` de "2026-02-30" crea una tarea que
  vence el 2 de marzo sin avisar. El mes 13 SI se atrapa —ahi la fecha si sale
  invalida— pero el dia no, que es el caso que alguien escribe de verdad. El
  contrato REST no comparte ese helper: `fechaSola` de `packages/contracts`
  valida con un ida y vuelta —reconstruye la fecha y la compara con lo que
  entro— y eso si lo atrapa. El arreglo es el mismo ida y vuelta dentro de
  `aFecha`, y conviene hacerlo ahi y no duplicar el de contracts, porque el borde
  MCP no puede importar del paquete de contratos HTTP.
- GET /api/audit NO se puede filtrar por `request_id`, y es el filtro que mas se
  va a extra~nar: correlacionar el `X-Request-Id` que devolvio una respuesta con
  lo que esa peticion escribio es el uso mas natural del log, y es exactamente lo
  que la 6.1 promete al hacer coincidir los dos valores. No esta porque
  `audit_log` no tiene indice por esa columna (4.1 declara solo
  `(entity_type, entity_id, created_at)` y `(created_at)`), y es la tabla que
  crece con CADA escritura del sistema: un filtro sin indice ahi es un seq scan
  que empeora solo, y ofrecerlo seria peor que no tenerlo porque funcionaria bien
  el primer mes. Lo mismo vale para `action`, `actor_type`, `actor_name` y
  `client_id`, que tampoco tienen indice, pero ninguno de esos se pide igual. El
  arreglo es un indice por `request_id` en una migracion ADITIVA —no toca ninguna
  de las cuatro restricciones que Prisma propone dropear— y despues el filtro en
  el contrato y en `ListAuditQuery`. Es su propio paso.
- La PURGA diaria de `idempotency_record` que pide la 6.5 NO existe, y no
  hay scheduler en el proyecto. Hoy no molesta: la tabla crece como mucho una
  fila por POST con cabecera, que en uso personal son unas pocas. El
  disparador para hacerla es que la tabla crezca de verdad o que el sistema deje
  de ser personal. La opcion mas barata entonces es un script en `packages/db`
  enganchado al planificador del sistema operativo, como se hace con
  `apikey:create`. DESCARTADA explicitamente la de un `setInterval` en el proceso
  de Next: se duplica por instancia y el hot reload la multiplica, asi que borra
  filas desde varios relojes a la vez y ninguno es observable.
- `apps/web/lib/http.ts` mantiene su PROPIA `CuerpoError` y su
  `HTTP_POR_CODIGO`, y HOY coinciden con `packages/contracts/src/error.ts` —los
  compare campo por campo y codigo por codigo al escribirlo— pero NADA lo
  comprueba. O sea que es un RT-03, la desincronizacion que la ADR-006 existe
  para prevenir, y esta DENTRO del paso que vino a cerrarla: el generador de
  OpenAPI necesitaba el modelo de errores de la 6.4 como esquema y ese modelo no
  existia en ninguna parte salvo como interfaz de TypeScript en el adaptador. El
  arreglo es que `http.ts` DERIVE de `error.ts` en vez de declararlo otra vez.
  Sale barato y no pierde nada: `HTTP_POR_CODIGO` es `Record<DomainErrorCode,
  number>`, o sea exhaustivo por typecheck sobre los codigos del nucleo, asi que
  un codigo de dominio nuevo sin estado asignado seguiria fallando en `tsc`
  despues del cambio. Lo que NO se puede hacer es al reves —mover los codigos a
  contracts y que el nucleo los lea— porque contracts es una hoja del grafo
  (3.3) y no puede importar `DomainErrorCode`; por eso `ESTADO_POR_CODIGO` es un
  mapa de codigo a estado y no un enum que se crea la fuente de los codigos.
- El ESQUEMA ZOD de configuracion que pide la 11.2 —validar el entorno entero al
  arrancar, con una variable ausente o invalida impidiendo el arranque— NO
  existe. Lo que hay en `apps/web/instrumentation.ts` son dos comprobaciones a
  mano, `DATABASE_URL` y `RATE_LIMIT_ENABLED`, y es facil leerlas como que la
  11.2 ya esta cumplida: no lo esta. Las que faltan son las demas variables de
  esa tabla, y la que mas importa es `API_KEY_PEPPER`, que hoy se valida RECIEN
  en la primera peticion autenticada —el `ApiKeyService` se construye por
  peticion y su constructor falla con un pepper vacio— asi que un despliegue sin
  pepper arranca bien y devuelve 500 en la primera peticion con clave, que es
  exactamente el 'fallo posterior en tiempo de ejecucion' que la 11.2 prohibe.
  El arreglo es un esquema Zod en `apps/web` —no en `packages/contracts`, que es
  una hoja y no valida entornos— consumido desde `register()`. Ojo con una cosa
  al escribirlo: `register()` corre TAMBIEN en el runtime edge, donde no hay
  `process.exit`, y por eso la comprobacion de hoy sale temprano si
  `NEXT_RUNTIME` no es nodejs.

## Entorno

- Windows 11, PowerShell. La ruta del proyecto contiene un espacio: entrecomillá
  cualquier ruta en scripts y configuración.
- Node 20+, pnpm workspaces, TypeScript strict con noUncheckedIndexedAccess.
- PostgreSQL 16 en Docker Desktop.
- `pnpm run verify` corre los tests contra la base de desarrollo y la TRUNCA:
  cualquier dato cargado a mano ahí se pierde en el próximo verify. Y lo que
  quede después NO es dato real: es el residuo de la última prueba que corrió,
  porque cada una trunca en su `beforeEach` y siembra lo suyo. Cuál sea ese
  residuo cambia con el orden de las suites —este archivo decía "fixture de
  `apps/mcp-stdio`" y dejó de ser cierto en cuanto `apps/web` pasó a correr
  después—, así que no lo anotes acá: si ves algo y dudás, buscá de dónde sale
  con `grep -rn "<lo que viste>" --include=*.test.ts .`. Ya engañó una vez, con
  un título de TAREA leído como nombre de tablero.
- Eso incluye `api_key`: verify también la vacía, así que cualquier clave
  emitida a mano desaparece en el próximo verify y hay que reemitirla con
  `pnpm run apikey:create`.
- Los scripts de package.json deben ser multiplataforma: nada de `rm`, `cp`,
  `export` ni here-docs.
- `apps/web` corre con `--webpack`, no con Turbopack, y por eso sus scripts de
  `dev` y `build` llevan el flag. `packages/core` usa specifiers NodeNext
  (`./domain/types.js` apunta a `types.ts`); esbuild hace esa sustitución solo
  —por eso `apps/mcp-stdio` no necesita nada— y los bundlers de Next no. Lo
  arregla `experimental.extensionAlias`, que Turbopack ignora explícitamente: con
  Turbopack fallan los ~30 imports del barrel. La salida es que `core` publique
  JS compilado, en vez de quedarse en webpack para siempre; el plazo que se le
  habia puesto —antes de F3— ya paso sin saldarla.
- Un paquete listado en `serverExternalPackages` tiene que ser RESOLUBLE desde
  `apps/web` o la entrada es inerte: Next declara externo algo que no puede
  externalizar, lo empaqueta igual, y en dev lo empaqueta partido en
  vendor-chunks. Con pnpm estricto no alcanza con que lo declare un paquete del
  workspace —`packages/db` lo resolvía y `apps/web` no—, así que el paquete va
  también en las dependencias de `apps/web`, apuntando a la MISMA copia física.
  Comprobalo por realpath de `require.resolve("@prisma/client/runtime/client")`
  desde los dos paquetes, nunca por número de versión: en el store puede haber
  dos entradas de la misma versión con hashes de peers distintos, y enganchar la
  otra deja dos copias reales en vez de una. El síntoma típico si se rompe es
  PostgreSQL 42601 SOLO en dev, con los fragmentos `Prisma.Sql` anidados
  bindeados como parámetros en vez de interpolados: son dos copias del runtime
  en el proceso, y el `Sql` que construye `packages/db` no es `instanceof` el
  `Sql` que evalúa `$queryRaw`. `pg` dejó de ser inerte cuando entró como
  devDependency de `apps/web` para la suite de contrato: comprobado por realpath,
  hay UNA sola copia física vista desde `apps/web`, `packages/db`,
  `packages/core` y `apps/mcp-stdio`, y el camino de `$queryRaw` con fragmentos
  `Prisma.Sql` sigue devolviendo 200 en dev, que es donde aparecería el 42601.
  `pino` entró por lo mismo con el log de la 11.1, y se comprobó igual: una sola
  copia física vista desde `apps/web` y `apps/mcp-stdio` —el mismo realpath, no el
  mismo número de versión— y después `next build` más `next start` con
  GET /api/health devolviendo 200 y escribiendo su línea JSON, que es donde se
  vería si el bundler lo hubiera partido.
  Pendiente conocido: `@prisma/adapter-pg` SIGUE inerte y se empaqueta. Hoy no
  rompe nada —el bug era específico del runtime de `@prisma/client`— y el arreglo
  sería idéntico.
- Un typecheck que PASA donde esperabas que fallara puede ser un
  `tsconfig.tsbuildinfo` viejo, no un mecanismo roto. Pasó una vez con el
  `Record` exhaustivo de errores de `apps/web/lib/http.ts`: se agregó un código
  de dominio sin mapear, `tsc --noEmit` dio verde, y borrando
  `apps/web/tsconfig.tsbuildinfo` apareció el TS2741 que se esperaba. No se
  pudo reproducir después —con la caché sana lo detecta, y el typecheck del
  monorepo entero también—, así que es observación y no bug confirmado. El
  reflejo igual: borrá el tsbuildinfo del paquete y repetí ANTES de concluir
  que la salvaguarda no funciona. Vale sobre todo para las contrapruebas, que
  son justamente las que esperan rojo y donde un verde se lee como "el
  mecanismo no sirve" en vez de como "no se volvió a compilar".
- El `build` de `packages/contracts` NO ESCRIBE nada: comprueba. Corre el
  generador con `--check`, que arma el documento en memoria y lo compara con el
  `openapi.json` versionado, y falla si difieren. El que escribe es
  `pnpm run openapi:generate`. La asimetria ES el punto: si `build` reescribiera
  —como hacia al principio— verify pasaria en verde con un contrato
  desactualizado en el repo, porque lo primero que haria seria taparlo. Y el
  generador NO tiene modo por defecto, para que nadie lo llame sin decidir cual
  de los dos quiere: olvidar la bandera es un mensaje de uso, no una escritura.
- Ese check compara CONTENIDO y no bytes: normaliza CRLF a LF antes de comparar.
  Con `core.autocrlf=true` un clon fresco deja `openapi.json` en CRLF en disco
  mientras el generador siempre emite LF, asi que comparar bytes crudos fallaria
  recien clonado con el contrato perfectamente al dia. Pasar el archivo entero a
  CRLF NO rompe el check, y esta bien que no lo rompa, pero el estado intermedio
  engaña y esta medido: con el archivo en CRLF, `git status` lo muestra como
  ` M` —y `git update-index --refresh` dice `needs update`— mientras `git diff`
  sale VACIO, porque el blob normalizado es el mismo; un `git add` lo vuelve a
  dejar limpio sin stagear nada. O sea que ese ` M` no es un cambio de
  contenido, y buscarle uno es perder la tarde.
- No mates procesos `node` con un `Stop-Process` amplio en esta máquina: se
  llevan puestos los servidores MCP de la sesión, que también son `node`.
  Filtrá por PID o por línea de comando.
- Contrapruebas hechas con `sed -i`: `sed` reescribe el archivo en LF, y con
  `core.autocrlf=true` git lo entrega en CRLF. Así que comparar el sha256 justo
  después del `sed` inverso da MISMATCH sin que haya nada mal —el contenido es
  idéntico y `git diff` sale vacío—, y es fácil leerlo como "el revert no
  funcionó" y empezar a tocar cosas. El checksum se compara DESPUÉS de dejar que
  git reescriba el archivo, con `git checkout -- <archivo>`, no después del
  `sed`. Y al revés: `git checkout --` sobre un archivo que estaba en LF lo
  convierte a CRLF, que es churn invisible para git pero real en disco. Si hace
  falta dejar los bytes exactos que había, mirá primero con qué terminadores
  estaba (`file <archivo>`), y no uses `grep -c $'\r'` para averiguarlo desde
  esta herramienta: el `$'\r'` puede llegar como patrón vacío y entonces cuenta
  TODAS las líneas, que se lee igual que "el archivo es CRLF".

## Reglas que no se negocian

- Nunca `prisma db push`. Solo `prisma migrate dev` / `prisma migrate deploy`.
- Una `Idempotency-Key` identifica un INTENTO DE OPERACION, no un cuerpo. O sea
  que reusarla en OTRO endpoint, desde el mismo cliente, devuelve 422 aunque el
  cuerpo sea otro: la PK es `(key, client_id)` y el endpoint entra en el HASH, no
  como columna, asi que el segundo endpoint encuentra la fila del primero, ve un
  hash distinto y rechaza. Es DECISION TOMADA y no un efecto colateral: reusar
  una clave para otra operacion es un error del cliente —el que se paga tras un
  timeout, reintentando lo que no era— y el 422 se lo dice; sumar `endpoint` a la
  PK lo dejaria mudo, porque las dos peticiones convivirian sin que nadie se
  entere. Entre clientes DISTINTOS cada uno hace lo suyo, que es justo lo que la
  PK compuesta separa. Cambiar esta semantica NO es tocar el hash: es migrar la
  PK a `(key, client_id, endpoint)`.
- El metodo y la ruta entran en el hash de la 6.5. El caso que lo justifica no es
  el de dos cuerpos distintos —ahi los hashes difieren igual— sino el del MISMO
  cuerpo en dos endpoints, y la idempotencia se resuelve ANTES del esquema, asi
  que el cuerpo ni siquiera tiene que ser valido en el segundo. Medido sacandolos:
  POST /api/tasks devuelve 201 con `Idempotency-Replayed: true` y un TABLERO con
  sus cuatro columnas en el cuerpo, y cero tareas creadas.
- Las restricciones `UNIQUE ... DEFERRABLE` sobre `position` se declaran SOLO en
  SQL crudo dentro de la migración. No las declares como `@@unique` en
  `schema.prisma`: Prisma generaría una versión no diferible.
- NUNCA apliques lo que genera `prisma migrate dev` sin leerlo entero. Los
  invariantes que viven solo en SQL crudo —la FK compuesta
  `task_column_same_board`, la UNIQUE `column_board_pair` que esa FK
  referencia, y las UNIQUE DEFERRABLE `task_column_position_uniq` y
  `column_board_position_uniq`— no están en `schema.prisma`, así que Prisma
  los toma por drift y propone un DROP de cada uno en CADA migración nueva, sin
  que la migración tenga nada que ver con ellos. Aplicarlos se lleva puestos el
  orden denso 0..n-1 (ADR-004) y la garantía de que una tarea no apunte a la
  columna de otro tablero (4.2). El procedimiento es: generar SIEMPRE con
  `--create-only`, borrar a mano todo DROP que toque esas cuatro, y verificar
  con una consulta a `pg_constraint` / `pg_indexes` que las cuatro siguen
  presentes DESPUÉS de aplicar, con `condeferrable = t` en las dos de
  `position`. Que la migración corra sin error no prueba nada: los DROP se
  aplican limpiamente, y lo que se pierde no se nota hasta que falla un
  reordenamiento o entra una tarea en la columna de otro tablero.
- La FK `task → board_column` es `ON DELETE NO ACTION`, no `RESTRICT`. RESTRICT
  se evalúa fila a fila y rompe el borrado en cascada de un tablero.
- Los UUID los genera la aplicación, no la base.
- `packages/db/src/client.ts` exporta un Proxy, no el cliente. El `PrismaClient`
  se construye en el PRIMER acceso a una propiedad y ahí se valida
  `DATABASE_URL`; importar el módulo no construye nada, y de eso depende que una
  herramienta pueda cargar un módulo del árbol sólo para inspeccionarlo sin una
  base configurada —el caso que lo destapó fue el "Collecting page data" de
  `next build`—. El invariante "un cliente por proceso" descansa en DOS caches y
  las dos hacen falta: el global, que se escribe sólo fuera de producción para
  el hot reload, y una variable de módulo. Sacar la segunda abre un pool por
  acceso en producción. Los métodos se devuelven con `bind` al cliente real,
  porque invocarlos con el proxy como `this` revienta en el primer campo
  privado. Consecuencia: `prisma.$transaction` NO es idéntico entre accesos, y
  `prisma instanceof PrismaClient` da false. Si algún día hace falta el
  instanceof, la salida es exponer el cliente por una función, no ampliar las
  trampas del proxy.
- El orden de tareas es entero denso 0..n-1 por columna, sin huecos. Toda
  operación que altere el orden reescribe la secuencia completa dentro de una
  transacción.
- El registro de auditoría se escribe SIEMPRE dentro de la transacción de la
  operación que audita, nunca en una propia ni después. Por eso
  `AuditService.registrar()` recibe una transacción y no acepta un cliente
  suelto: la firma es la que hace imposible un registro huérfano, no la
  disciplina de quien la llama. Si la operación falla no queda registro, y si
  falla el registro se revierte la operación entera. Corolario que sí hay que
  sostener a mano: como las operaciones reintentan (40001 y las dos UNIQUE
  diferidas de orden), el evento se arma y se escribe DENTRO del intento, así
  el registro del intento abortado se va con su transacción. Nunca acumules
  eventos fuera de la transacción para escribirlos al final: eso deja un
  registro por intento y no se nota hasta que auditás en serio. Lo cubre la
  prueba de reintento de `packages/core/test/audit.test.ts`, que aborta el
  primer intento a propósito.
- (A partir de F1b) `packages/core` no importa Next, ni el SDK de MCP, ni nada
  de HTTP. Los adaptadores (REST, MCP) no contienen reglas de negocio. Ningún
  adaptador importa Prisma directamente.
- `packages/contracts` es una HOJA del grafo de dependencias (3.3): no importa
  NADA del proyecto, ni siquiera el núcleo. Por eso sus límites —los de nombre,
  descripción y paginación— están escritos ahí otra vez en vez de leerse de
  `packages/core`: que hoy coincidan con los del dominio no los hace el mismo
  dato, estos son los que documenta el borde. Si alguna vez hace falta que
  coincidan por construcción, la salida es generar unos de los otros, no importar
  el núcleo.
- `packages/core/src/domain/api-key.ts` NO puede importar nada del resto del
  núcleo: solo `node:crypto`. El script de administración lo carga por ruta
  directa (`../src/domain/api-key.ts`) apoyándose en el stripping de tipos
  nativo de Node, que NO resuelve los specifiers NodeNext del proyecto
  (`./x.js` -> `x.ts`), así que un solo import interno lo rompe. Se comparte en
  vez de recalcular el hash en el script porque, si los dos difirieran, se
  emitirían claves que no validan y el síntoma sería un 401 indistinguible de
  una clave mal tipeada. Consecuencia: ese comando requiere Node 22.6+, por
  encima del Node 20+ que declara el resto del proyecto; afecta solo al script,
  no a la app. Si algún día hace falta importar algo ahí, la salida es
  empaquetar el script con esbuild como `apps/mcp-stdio`, no relajar la regla.
- El pepper llega INYECTADO al `ApiKeyService`, nunca leído de `process.env`
  dentro del núcleo: el núcleo recibe datos ya validados (3.2), y así el
  servicio se prueba con dos peppers distintos en un mismo test. El constructor
  falla con un pepper vacío, y falla al construir y no en la primera petición:
  un pepper vacío hashea sin protestar y produce claves cuyo hash no depende de
  ningún secreto, o sea un fallo silencioso del peor tipo.
- El `ApiKeyService` se construye POR PETICIÓN, no a nivel de módulo como
  `crearCorePort()`. Su constructor exige el pepper, y leerlo al importar el
  módulo rompe el "Collecting page data" de `next build`: es la misma trampa que
  resolvió el proxy perezoso de `packages/db`.
- El spread condicional de `description` en PATCH /api/boards/{id} lo defiende el
  TYPECHECK —`exactOptionalPropertyTypes`— y NO la suite. `BoardService.update`
  decide con `patch.description === undefined`, así que una clave PRESENTE en
  undefined se comporta igual que una ausente: cambiarlo por
  `description: entrada.data.description` deja la suite de `apps/web` ENTERA en
  verde y falla con TS2375. O sea que el reflejo de "si no rompe ningún test, no
  protege nada" acá se lee al revés: borrar el spread rompe `verify` un paso
  antes, en `typecheck`. Lo que la suite SÍ atrapa son los dos colapsos que
  compilan, y cada uno tiene su prueba: `?? null` hace que una descripción
  ausente pase a borrar (falla "ausente conserva") y `== null` en vez de
  `=== undefined` hace que `null` deje de borrar (falla "null borra").
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
- Las filas de `board_column` se bloquean con FOR NO KEY UPDATE, no con
  FOR UPDATE. Insertar o mover una tarea toma FOR KEY SHARE sobre la fila de
  su columna al validar la FK, y FOR UPDATE choca con ese modo: una operacion
  de columnas que lo tomara y despues esperara filas de tarea se
  interbloquearia con un move en curso. FOR NO KEY UPDATE no choca y sigue
  serializando las operaciones de columnas entre si.
- Se reintenta ante 40001 y ante violacion de las dos UNIQUE diferidas de
  orden, `task_column_position_uniq` y `column_board_position_uniq`: las tres
  son contencion legitima, y el tope es el mismo, dos reintentos. Sobre una
  columna vacia o un tablero sin columnas no hay filas que bloquear, asi que
  dos operaciones simultaneas calculan la misma position sin verse y la
  restriccion diferida las separa recien en el COMMIT. La lista va por nombre
  explicito: `board_column_board_id_key_key` tambien es una UNIQUE, y
  reintentarla seria reintentar para siempre un error real del llamador.
- Hay DOS limites de contencion conocidos, los dos aceptables para uso
  personal. Terminan igual —40001 tras agotar los dos reintentos— pero son
  mecanismos distintos y no se arreglan igual. No los confundas.
- (1) Contencion sobre UNA columna. Bajo REPEATABLE READ, N operaciones
  concurrentes sobre las filas de una misma columna se serializan en escalera:
  la primera commitea y las demas despiertan con el snapshot viejo, asi que la
  ultima necesita N intentos, es decir N-1 reintentos. Con el presupuesto en
  dos, el maximo que soporta una columna son 3 operaciones concurrentes.
  Medido aislado: con N=4 falla 20 de 20 corridas; con N=3, 0 de 20. El conteo
  de intentos por operacion es la escalera exacta: con N=4 y maxRetries=2 da
  1, 2, 3 y un cuarto que necesitaba 4 y se queda en 3; con maxRetries=3 se
  completa en 1, 2, 3, 4. Por eso ningun test de concurrencia sobre una misma
  columna usa mas de 2 operaciones: probar que el orden queda denso no
  necesita mas, y una tercera convierte el test en una medicion del
  presupuesto de reintentos en vez de la correccion. Subir `maxRetries` NO es
  la salida por defecto: es la palanca correcta solo si algun dia aparece un
  caso de uso real con mas de 3 escritores simultaneos sobre una columna, y en
  uso personal no existe.
- (2) Cadena de invalidacion sobre `board_column`. Distinto de (1): no es la
  escalera de una columna, es una cadena que dura mas de una transaccion. Cada
  create de columna reescribe TODAS las filas de `board_column` del tablero, y
  cada create de tarea toma FOR KEY SHARE sobre la fila de su columna al
  validar la FK. Varios create de columna concurrentes sobre un mismo tablero
  se serializan entre si y forman esa cadena, asi que un create de tarea
  simultaneo puede ser abortado por cada eslabon, agotar sus dos reintentos y
  fallar. Medido con 4 operaciones concurrentes: falla 3 de cada 15 corridas.
  El backoff con jitter NO lo resuelve (mismas 3 de 15 con el y sin el): hay
  que saltear la cadena entera, no desfasarse dentro de ella. Si algun dia
  importa, la salida es un backoff del orden de la duracion de la cadena —con
  40 ms de base pasa 10 de 10— y no mas reintentos. Por eso la prueba de
  compatibilidad de modos de bloqueo en `packages/core` usa una operacion de
  cada tipo y no cuatro.
- No se reintenta NUNCA ante 40P01. Un interbloqueo significa que el orden de
  bloqueo esta mal, y reintentarlo esconde el bug en vez de arreglarlo. Es
  ademas lo que lo hace distinguible de un reintento: un 40P01 sube como
  rechazo, con la firma de ~1150 ms del `deadlock_timeout`, y nunca se absorbe.
  El reintento que SI se observa en los tres casos de concurrencia de la 10.1
  absorbe un 40001, no una UNIQUE diferida; verificado corriendo los mismos
  escenarios con `maxRetries: 0`.
- El orden de bloqueo canonico de la 5.4 —`ORDER BY column_id, id`, el MISMO
  para los dos movimientos— esta MEDIDO y no supuesto: rompiendolo a proposito
  (ordenando la columna de ORIGEN primero, que es distinto para cada
  movimiento) aparecen interbloqueos reales, 3 en 300 rondas —~1% por ronda—
  contra 0 en 200 rondas con el orden canonico. O sea que esa linea hace algo.
  PERO la prueba C2 de `packages/core`, con sus 5 rondas, atrapa esa regresion
  cerca del 5% de las veces: no es inestable —con el codigo correcto da 0
  interbloqueos siempre— es INSENSIBLE, que es otra cosa y no se nota
  mirandola. El detector real es `packages/core/test/orden-de-bloqueo.test.ts`,
  460 rondas (~55 s), que NO corre en verify y se invoca a mano:

  ```
  pnpm --filter @taskman/core run test:orden-de-bloqueo
  ```

  Si tocas el orden de bloqueo, corre ese. Que verify pase no prueba nada ahi.

## Servidor MCP

- El registro de herramientas y `TaskManagerPort` viven en `packages/core/mcp`,
  pero el nucleo NO importa el SDK de MCP: las herramientas se declaran como
  dato (`McpToolDefinition`) y cada app las monta sobre su `McpServer`. Es lo
  que hace compatibles la regla de dependencias de arriba con el "registro
  unico" de la 8.1.
- La resolucion por nombre de la 8.3.1 esta en `packages/core/src/mcp/resolve.ts`
  y es UNA sola para tablero, columna y tarea. Si hace falta una regla distinta
  para alguna entidad, va como dato en el ambito, no como un `if` en el modulo.
- El ambito de una resolucion por titulo es SIEMPRE un tablero, nunca global.
  Por eso `board` es obligatorio en `move_task` cuando la tarea viene por
  titulo.
- Una coincidencia ambigua NUNCA se resuelve eligiendo la primera. Devuelve
  AMBIGUOUS_MATCH con todos los candidatos y un `hint` que dice que hacer.
- `apps/mcp-stdio` corre en modo `core` (MCP_PORT_MODE de la 8.1): habla con la
  base por los servicios, en el mismo proceso, sin pasar por HTTP. La politica de
  operaciones destructivas de la 8.3.2 se controla con MCP_DESTRUCTIVE_POLICY, y
  el log estructurado es el de la 11.1: a stderr, nunca a stdout.
- stdout es el canal del protocolo: en `apps/mcp-stdio` todo diagnostico va a
  stderr. Un `console.log` suelto rompe la sesion MCP entera.
- `apps/mcp-stdio` se empaqueta con esbuild porque `@taskman/core` y
  `@taskman/db` publican TypeScript crudo y `.mcp.json` arranca el servidor con
  `node dist/index.js`. Por eso ese paquete declara `@prisma/client`,
  `@prisma/adapter-pg`, `pg` y `zod` aunque su codigo no los importe: son las
  dependencias de lo que se empaqueta, y con pnpm cada paquete solo ve las
  suyas.

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