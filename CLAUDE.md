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
  corre las suites contra PostgreSQL real; cada paquete imprime su total, después
  levanta `next dev` y le pide tres rutas (`pnpm run humo:dev`) y al final compila
  y sirve la app para pasarle Playwright (`pnpm run e2e`).
- **Qué cubre el nivel de extremo a extremo** de la 10, y sobre todo qué NO: los
  `apps/web/e2e/*.spec.ts`, y al pie de `tablero-lectura.spec.ts` está el mapeo
  contra los diez escenarios CT de la 10.2 con el motivo de cada hueco. Los datos
  de los que parte son la siembra determinista de la 10.3, en `e2e/semilla.ts`.
- **Qué endpoints existen**, con su verbo y su scope, uno por línea:

  ```
  grep -rnE "^export (const|async function) (GET|POST|PATCH|PUT|DELETE)" apps/web/app --include=route.ts
  ```

  El `conAuth("…")` de cada línea es el scope que ese endpoint exige (7.2). Las
  tres de `/mcp` salen con `conAuthMcp`: autentican con la misma clave y el mismo
  401, pero sin un scope por endpoint, porque en MCP el scope es de cada
  herramienta y lo aplica `crearHerramientas` con los de la clave (8.1). DOS
  líneas salen sin autenticar, y no son el mismo caso:

  `/api/health` es el único endpoint DEL CONTRATO de la 6.2 sin autenticación, y
  eso es TODO lo que lo hace distinto: no tiene 401, 403 ni el 429 de la 7.3, que
  se cobra por clave. El X-Request-Id SÍ lo lleva, como toda respuesta (6.1);
  genera el suyo con la misma `nuevoRequestId()` que usa `conAuth`.

  `/eventos` NO ES DEL CONTRATO: es el flujo de Server-Sent Events con el que el
  tablero se entera de que algo cambió (CT-06 y CT-07). Aparece en este grep
  porque también es un `route.ts` bajo `app/`, no porque sea un endpoint público,
  y por eso está fuera de `/api`: la lista de la 6.2 dice algo simple y cierto
  —todos autentican menos health— y meter ahí una ruta que no puede autenticar la
  ensuciaría. NO autentica porque la UI no usa ninguna API key: invoca los
  servicios en el mismo proceso y no consume su propia API pública (9.1), así que
  no tiene con qué. LO QUE EXPONE, por cada escritura del sistema: el tipo de
  actor, la acción, el tipo de entidad y su UUID. Nada de títulos, descripciones,
  fechas ni contenido. Y que no lleve contenido NO quiere decir que el contenido
  esté protegido: la UI entera no autentica. `GET /` sirve todos los tableros con
  sus títulos y fechas, con `?tarea=` también la descripción, y las Server
  Actions crean, editan, mueven y borran sin clave ni scopes (las dos lecturas,
  medidas con `curl` sin cabecera `Authorization`: 200 y los datos en el HTML).
  O sea que `/eventos` no expone nada que la página no exponga ya. Es el desvío
  "La UI no tiene autenticación", más abajo.
- **Qué endpoints faltan**: la tabla de la 6.2 es el objetivo y el comando de
  arriba es el estado; la resta de los dos es la lista. Cualquier copia escrita
  acá empieza a envejecer el mismo día.
- **Qué herramientas MCP hay**: un archivo por herramienta en
  `packages/core/src/mcp/tools/`, montadas en `registry.ts`. El catálogo que
  tienen que cubrir es el de la 8.2.
- **En qué rama y fase estás**: `git branch --show-current` y `git log --oneline`.
  Los nombres de fase (F1b, F3, F4…) salen del plan de la 12.

Lo que no caduca está en las secciones de abajo, que son las que valen: la deuda
conocida, los desvíos declarados de la especificación, las trampas del entorno,
las reglas que no se negocian y los invariantes del servidor MCP.

## Deuda conocida

Salio del uso real y de las revisiones, no de la especificacion. Ninguna esta
arreglada; anotarlas aca es para que no se redescubran de cero.

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
- Un argumento DESCONOCIDO de una herramienta MCP se descarta en silencio. Es el
  MISMO hueco que el borde REST cerro con `leerConsulta` —el esquema declara una
  forma y el borde no la honra— en la otra superficie, y por eso se anota aca al
  irse aquel: `definirHandler` (`packages/core/src/mcp/respuesta.ts`) arma el
  esquema con `z.object(shape)`, y un `z.object` no estricto QUITA las claves de
  mas en vez de rechazarlas. MEDIDO por /mcp: un `tools/call` de `list_tasks`
  con `{ board: "Tablero", status: "DONE" }` devuelve 200 y el TABLERO ENTERO,
  las dos tareas, sin una palabra sobre el `status`. El agente que lo mando cree
  que acoto. El arreglo es una sola palabra —`strictObject`— pero NO es un
  arreglo al pasar: toca las once herramientas a la vez, y a diferencia de una
  query que escribe una persona, estos argumentos los arma un modelo, asi que
  hay que ver primero si algun cliente manda campos de relleno que hoy se caen
  solos. Va junto al paso que derive los esquemas de las herramientas de
  `packages/contracts` (entrada de mas abajo), que es donde se decide que forma
  tienen esas entradas.
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
  entro— y eso si lo atrapa. Que haya DOS validaciones de la misma fecha es la
  causa y no un detalle: la 3.3 permite que `packages/core` importe `contracts`, y
  la ADR-006 pide que los esquemas de las herramientas se deriven de ahi, asi que
  el arreglo es que la fecha de las herramientas se valide con `fechaSola`,
  dentro del paso de la entrada siguiente. Copiar el ida y vuelta en `aFecha`
  cerraria este caso y dejaria abierto el hueco que lo produjo. (Esta entrada
  decia antes que el borde MCP no puede importar del paquete de contratos: era
  FALSO, lo desmienten la 3.3 y la ADR-006, y no hay que volver a leerlo como
  regla.)
- Los ESQUEMAS DE ENTRADA DE LAS HERRAMIENTAS MCP NO SE DERIVAN DE
  `packages/contracts`, y la ADR-006 lo pide con esas palabras: los esquemas de
  contracts son "la unica definicion", y de ellos se derivan los tipos, el
  OpenAPI "y los esquemas JSON de las herramientas MCP". Hoy `packages/core` no
  depende de `@taskman/contracts` —ni en su package.json ni en un import— y cada
  herramienta escribe su esquema a mano en `packages/core/src/mcp/tools/`:
  `PRIORIDADES` de `campos.ts` repite la de `contracts/src/task.ts`, y `aFecha`
  reimplementa `fechaSola` con un agujero (entrada anterior). Es el RT-03 de la
  12.2 ya ocurrido, no un riesgo. La 3.3 lo permite —`packages/core` y
  `apps/mcp-stdio` pueden importar `contracts`, que sigue siendo hoja— asi que no
  hay regla que mover. Lo que ese paso tiene que decidir es QUE se deriva: las
  entradas de las herramientas no son los cuerpos REST —`move_task` recibe
  `task`, `board` y `to_column` por nombre, donde POST /api/tasks/{id}/move pide
  `column_id` o `column_key`—, asi que el cuerpo entero no sale de ahi; lo que
  comparten son piezas, como la prioridad, la fecha y los limites de largo. Es su
  propio paso, no un arreglo al pasar.
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
- `last_used_at` de la 7.1 NO se actualiza, y el problema es mas grande de lo que
  suena: LA COLUMNA NO EXISTE. La 4.1 declara `lastUsedAt` en el modelo `ApiKey` y
  `schema.prisma` no la tiene, asi que esto no es agregar una escritura sino una
  MIGRACION ADITIVA primero —y con el procedimiento de siempre: `--create-only`,
  borrar los DROP que Prisma propone sobre las cuatro restricciones de SQL crudo, y
  verificar despues con `pg_constraint`—. Lo que pide la 7.1 encima es que se
  actualice como maximo una vez por minuto por clave, o sea un throttle, para no
  convertir cada lectura en una escritura; el gancho natural es el cache de claves
  que ya existe, que sabe cuando una entrada se refresco. El disparador para
  hacerlo es querer saber que claves estan vivas —auditar claves sin uso, o
  revocar por abandono— que en uso personal con dos claves no se pregunta. Hasta
  entonces el dato no existe y ninguna consulta lo puede suponer.
- DIVERGENCIAS CONOCIDAS entre la 4.1 y `schema.prisma` en el modelo `ApiKey`. No
  son deuda a arreglar: son decisiones de F1 que el documento no refleja, y estan
  escritas para que nadie las lea como un error al comparar los dos. `prefix` es
  VarChar(24) y la 4.1 dice (16) —`tmk_live_` mas 6 caracteres son 15, asi que 16
  alcanza justo y 24 deja aire—; `hash Char(64)` es `keyHash VarChar(64)` y ADEMAS
  `@unique`; `scopes String[]` es el enum `Scope[]`, que es mas estricto; y hay un
  `updatedAt` que la 4.1 no declara. La que SI falta es `lastUsedAt`, y esa tiene
  su entrada arriba.
- La VENTANA DE REVOCACION del cache de claves de la 7.1: una clave revocada
  sigue autenticando hasta 60 s. Es la consecuencia aceptada de cachear la fila
  de `api_key` y esta MEDIDA de punta a punta, no supuesta: con el servidor
  arriba, 200 antes de revocar, 200 justo despues del UPDATE, 401 a los 65 s.
  NO se eligio por comodidad: hoy no hay donde enganchar la invalidacion. La
  revocacion es un `UPDATE api_key SET revoked_at = now()` que una persona tipea
  en psql —no hay endpoint ni script— asi que 'invalidar al revocar' exige
  construir primero ese camino, y ademas el script correria en OTRO proceso, que
  no comparte el cache. La salida barata mientras tanto: reiniciar el proceso lo
  vacia, porque esta en memoria, asi que una revocacion urgente es el UPDATE mas
  un reinicio. El orden para cerrarla de verdad es (1) un `apikey:revoke`
  simetrico de `apikey:create`, que falta igual —revocar tipeando SQL a mano es
  su propio riesgo— y (2) recien entonces LISTEN/NOTIFY o un cache compartido,
  porque el problema real es entre procesos. `reiniciarCacheDeClaves()` ya existe
  y es el gancho que usaria cualquiera de las dos.
- El aviso de cambios NO DISTINGUE TABLERO. `taskman_cambios` es un canal unico y
  `AvisoDeCambio` no lleva el tablero, asi que una escritura en OTRO tablero hace
  que `ColumnList` refresque el que se esta mirando. Hoy cuesta un render de mas y
  nada visible: la marca de cambio ajeno se cuelga del id de la tarea, y un id de
  otro tablero no encuentra tarjeta. Scopearlo exige que el aviso sepa el tablero
  de cada escritura, o un canal por tablero con quien escucha re-suscribiendose
  al cambiar de tablero.
- No hay INDICADOR VISIBLE de que el flujo de cambios se cayo. El estado vive en
  `data-cambios` de `ColumnList` ("conectado" o "conectando") y nada lo pinta:
  una persona con el tablero sordo no tiene como enterarse salvo mirando el DOM.
  Desde be319a6 el atributo dice la verdad cuando la escucha se cae y se cierra;
  lo que falta es mostrarlo. Tampoco distingue "reintentando" de "se rindio": si
  `EventSource` abandona —ante una respuesta que no es 200, como el 204 con el
  que las pruebas cortan el flujo— el atributo se queda en "conectando".
- Una conexion `LISTEN` que muere SIN CERRARSE —corte de red, portatil
  suspendido— deja el tablero SORDO y "conectado". `pg` solo se entera de una
  caida por un `error` o un `end`, y sin FIN ni RST no llega ninguno, asi que
  `lib/cambios.ts` no tiene nada que atender y los flujos siguen abiertos con su
  latido. Es la mitad que be319a6 NO arreglo, y es mas frecuente que el caso
  arreglado. NO ESTA MEDIDA.
- SILENCIO EN EL LOG durante una caida larga de la base. Cuando el `LISTEN` se
  cae, el cliente `pg` emite `error` y eso escribe dos lineas `listen`; los
  reintentos que siguen —cada pestana abierta vuelve a pedir `/eventos` cada
  ~3 s, y cada pedido intenta conectar— no escriben ninguna, porque el `catch`
  de la ruta cierra el flujo sin registrar. MEDIDO con `docker compose stop
  postgres`: la caida sumo dos lineas `listen` al log, y no sumo ninguna mas
  durante cuatro reintentos fallidos. Si el `LISTEN` no pudiera volver con la
  base arriba —por credenciales, por ejemplo— quedaria solo esa primera traza
  mientras las pestanas reintentan.
- `ColumnList` SIGUE MONTADO al cambiar de tablero: la pagina lo renderiza sin
  `key`, asi que React reusa la instancia y su estado de cliente cruza de un
  tablero al otro. Lo visible: el aviso de un arrastre fallado en un tablero sigue
  arriba del otro hasta el siguiente arrastre, porque el error solo se limpia al
  empezar uno. Sin `key` A PROPOSITO: ponerla remontaria `ColumnList` en cada
  cambio y con el reabriria `/eventos`, y un aviso que llegue en ese hueco se
  pierde.
- Un tablero FUERA DE LA PRIMERA PAGINA del listado —mas de
  `LIMITE_PAGINA_MAXIMO` tableros— se abre por su enlace, porque `cargarVista` lo
  carga por id, pero no aparece en la barra ni queda marcado: la barra lista solo
  la primera pagina y dice "y mas sin mostrar". En uso personal no pasa.
- Las Server Actions NO VALIDAN CON EL CONTRATO. `lib/acciones.ts` llama al
  nucleo sin pasar por los esquemas de `packages/contracts`, y la existencia del
  dia de `due_date` solo la valida el contrato (`fechaSola`): `editarTarea` la
  convierte con `aFechaUtc`, que no comprueba nada, y `TaskService.update` la
  asigna como llega. O sea que un POST armado a mano contra la accion con
  "2026-02-30" guarda el 2 de marzo sin avisar, igual que la entrada de `aFecha`
  para MCP. Lo medido es la conversion (`new Date("2026-02-30T00:00:00.000Z")`
  da `2026-03-02`); el POST a mano no se reprodujo. Desde la UI real no pasa,
  porque `<input type="date">` solo produce fechas validas. Incumple ademas la
  3.2, que pide a los adaptadores validar con el esquema de contratos, y vale
  para cualquier campo que el contrato restrinja y el dominio no: una accion es
  un POST publico y sus tipos no existen en tiempo de ejecucion.
- Un BORRADO que falla por error interno NO MUESTRA EL `requestId`: `borrar` en
  `task-editor.tsx` pinta solo `resultado.mensaje`, mientras `ResultadoAccion`
  (`lib/acciones.ts`) dice que el `requestId` se muestra justamente en el fallo
  no controlado, que es cuando es lo unico util que copiar. El guardado del mismo
  panel, el QuickAdd, "Nuevo tablero" y el arrastre si lo agregan.
- "HOY" SE CALCULA EN UTC, y la marca de vencida sale antes de tiempo. `esVencida`
  compara contra el dia UTC y el filtro `overdue` contra el `CURRENT_DATE` de una
  sesion en UTC (`domain/vencimiento.ts` explica por que tienen que coincidir),
  pero la fecha limite la elige una persona en su calendario local. En UTC-4 —la
  zona de esta maquina en verano— desde las 20:00 locales una tarea que vence HOY
  sale "Vencida" y entra en el filtro de vencidas, hasta la medianoche. La prueba
  de "vence hoy" no lo ve porque siembra relativo al dia UTC. La salida no es
  tocar `esVencida` sola: las dos puntas tienen que moverse juntas a la zona de
  quien mira, que el sistema hoy no conoce.
- La LINEA DE LOG POR PETICION de la 11.1 —request_id, metodo, ruta, estado,
  duracion, prefijo de clave y actor— solo la escriben `conAuth`, `conAuthMcp` y
  `/api/health` (`registrarPeticion`). Las Server Actions no escriben ninguna: dejan rastro en
  el log solo cuando fallan sin controlar (`registrarFallo`, con su request_id),
  asi que una accion que sale bien, o que devuelve un error de dominio, no
  aparece. Tampoco escriben linea el render de `GET /` ni `/eventos`. El
  request_id de una accion que escribe si queda en `audit_log`.
- GUARDAR UN CAMPO DEL PANEL REMONTA EL EDITOR ENTERO, y el campo al que se paso
  pierde el foco. El `key` de `TaskEditor` en `task-detail-panel.tsx` incluye
  los cuatro valores editables —a proposito, para que un cambio de otro actor
  entre en campos ya montados—, asi que el guardado propio tambien lo cambia. Si
  se edita el titulo y se pasa con Tab a la descripcion, el blur guarda, y cuando
  llega la revalidacion el editor se remonta: la descripcion pierde el foco, y lo
  que ya se hubiera tecleado en ella se pierde, porque desmontar no dispara
  `blur`. REPRODUCIDO en `e2e/panel-remontaje.spec.ts` ("DEUDA 1"), marcado con
  `test.fail()`: la prueba afirma que la descripcion conserva foco y texto, hoy
  falla, y la marca se quita el dia que se arregle. Tiene al lado una prueba de
  MONTAJE sin marca ("MONTAJE 1"), y no es redundante: `test.fail()` acepta
  CUALQUIER fallo, asi que si la retencion de Server Actions dejara de retener,
  o Tab dejara de llegar a la descripcion, la marcada fallaria por eso y seguiria
  verde. La de montaje es la que se pone roja en ese caso.
- LA PRIORIDAD GUARDA AL CAMBIAR y no al perder el foco, que es lo que pide la
  9.3: `CampoPrioridad` llama a `guardar` desde el `onChange` del `<select>`. Con
  teclado, cada flecha sobre el select cerrado cambia el valor y dispara
  `change` —medido en este Chromium, headless y con ventana—, asi que guarda un
  valor intermedio; y como la prioridad esta en el `key` del editor (entrada
  anterior), la revalidacion lo remonta. Si la flecha siguiente llega con ese
  guardado todavia en vuelo, la guarda `enVuelo` de `guardar` la descarta: el
  select muestra un valor que no se guardo hasta que el remontaje lo pisa.
  REPRODUCIDO en `e2e/panel-remontaje.spec.ts` ("DEUDA 2"), marcado con
  `test.fail()` y con su prueba de MONTAJE sin marca al lado ("MONTAJE 2", que
  afirma que la flecha cambia el valor), por lo mismo que la entrada anterior.
  LO QUE LA PRUEBA AFIRMA ES EL VALOR GUARDADO: dos flechas y Tab tienen que
  guardar MEDIUM, y hoy queda HIGH. La perdida de foco del select tras el
  remontaje se vio en la sonda de medicion y NO esta en la suite.
- MONTAJE 2 y DEUDA 2 dependen de que una flecha sobre un `<select>` cerrado
  cambie su valor, y eso esta MEDIDO SOLO en Chromium sobre Windows, headless y
  con ventana. En macOS NO ESTA MEDIDO: si ahi el navegador trata las flechas de
  otra forma, MONTAJE 2 se pone rojo, que es justo para lo que esta —avisar que
  el montaje de DEUDA 2 dejo de valer, en vez de dejarla verde por un motivo
  equivocado—.
- EL AVISO PROPIO LLEGA ANTES DE QUE LA PESTANA ANOTE SU `requestId`, y el
  filtro de `lib/cambios-propios.ts` queda sin efecto. MEDIDO en 10 de 10
  creaciones con QuickAdd —`next start`, Chromium headless, base local, una
  pestana, flujo `/eventos` vivo, sin retencion y sin carga—: llegaron 10 avisos
  y salieron 10 refrescos del router. Con `/eventos` cortado, 0 avisos y 0
  refrescos. El unico `router.refresh()` esta en `ColumnList` y lo piden dos
  cosas: un aviso que `esCambioPropio` no reconoce, o una reconexion del flujo.
  En esa corrida no hubo reconexion, asi que la medicion no cambia: ninguno de
  los 10 avisos se reconocio. El por
  que, como explicacion NO MEDIDA: el `NOTIFY` sale en el COMMIT, y la respuesta
  de la accion —despues de la cual se anota el `requestId`— sale cuando el
  servidor termino de renderizar el arbol revalidado.
  CONSECUENCIA REAL: cada escritura desde la UI pide un refresco de mas, que
  sale recien cuando la accion responde (medido reteniendo la respuesta), asi que
  la pagina se renderiza dos veces en el servidor y el arbol se actualiza dos
  veces en el cliente. Es rendimiento, no correccion.
  LO QUE NO PASA, para no leerlo de mas: un cambio propio NO se marca como
  ajeno. La marca exige actor distinto de USER y toda escritura de la UI audita
  como USER; lo mide `cambios-ajenos.spec.ts` en cada verify.
  LO QUE NO SE MIDIO: una base remota con latencia, Chrome con ventana y los
  otros tipos de escritura —editar, borrar, mover, crear tablero—, aunque por
  codigo se espera lo mismo, porque todos anotan el `requestId` despues de la
  respuesta.
  ARREGLO ELEGIDO Y NO HECHO: mientras la pestana tenga una accion en vuelo,
  retener los avisos de actor USER y volver a compararlos contra los propios
  cuando la accion responda; AGENT y API nunca son propios y siguen de largo.
  DESCARTADO anotar el `requestId` antes de invocar la accion: haria que el
  `request_id` de `audit_log` venga del navegador, y aceptar que un cliente
  elija lo que queda en la auditoria es un precio alto para ahorrar un refresco.
  Al arreglarlo, esta medicion se vuelve prueba de regresion: tres creaciones
  con QuickAdd y el flujo vivo tienen que dar CERO refrescos del router, contando
  las peticiones GET con cabecera `rsc: 1` que no llevan `next-router-prefetch`.

## Desvíos declarados de la especificación

Cosas que la especificación pide y que este repo NO hace, A PROPÓSITO.

**NO ES DEUDA Y NO HAY QUE SALDARLA.** La sección de arriba lista trabajo
pendiente: cada entrada de allí se borra en el commit que arregla lo que
describe. Ésta lista DECISIONES YA TOMADAS, y una entrada de acá solo se borra
si alguien decide lo contrario, no si alguien "se pone al día". Están juntas y
separadas por eso: quien lee "deuda" intenta pagarla, y pagar una de éstas es
deshacer una decisión sin haberla discutido.

Cada una dice de QUÉ sección se desvía y POR QUÉ, no solo qué falta. Si el
motivo dejó de valer, ahí está el disparador para volver a mirarla.

- **La UI es SOLO ESCRITORIO.** La 9.3 pide responsive —"en pantallas estrechas
  las columnas se muestran de una en una con navegación por pestañas"— y la 13
  del funcional lo pide entre los requisitos no funcionales —"diseño responsive
  para uso personal en desktop y móvil"—. Los dos quedan descartados: por debajo
  de 1024 px no se sirve una versión degradada sino un aviso. El motivo es que un
  tablero Kanban de a una columna deja de ser un tablero: lo que se mira en él es
  la relación entre columnas, y con pestañas hay
  que recordar lo que no se ve. Antes que hacerlo mal, no hacerlo y decirlo.
  Ya está escrito en `globals.css` y `layout.tsx`, está probado
  (`tablero-lectura.spec.ts`, el caso de 1023 px) y el usuario ve el motivo en
  pantalla. OJO: la definición de terminado de F3 (fila F3 de la 12) dice
  "comportamiento responsive verificado", así que este desvío la contradice de
  frente. EL CIERRE DE F3 SE ACEPTÓ CON ESTE DESVÍO, de forma explícita, el 14 de
  septiembre de 2026, pese a ese punto del DoD.

- **Sin TanStack Query**, que la 9.1 nombra con clave de caché `["board", boardId]`.
  El argumento largo está en la cabecera de `column-list.tsx`; en corto: es una
  caché de estado de servidor sobre una capa de fetch, y acá no hay ninguna de las
  dos —la carga inicial son propiedades de un Server Component y las mutaciones
  son Server Actions con `revalidatePath`—. Darle un fetcher exigiría o guardar
  una API key para que la UI hable consigo misma (7.2) o duplicar el render del
  servidor. Y lo que decide: NO PODRÍA dar el punto 3 de la 9.2. Una caché
  invalidada solo puede volver a PREGUNTAR después, y entre el commit y esa
  pregunta cabe otra escritura; el orden autoritativo tiene que venir en la
  respuesta de la acción, releído dentro de la transacción que lo escribió.
  El disparador que esa cabecera nombraba para volver a mirarlo —las
  notificaciones de cambios de agentes— ya ocurrió (`/eventos`) y no cambia el
  argumento: un aviso dispara `router.refresh()`, que vuelve a pedir el render
  del servidor, así que sigue sin haber una capa de fetch en el cliente. Queda el
  otro: una pantalla con varios tableros a la vez.

- **Sin "acción de nueva tarea" en BoardHeader**, que la 9.3 le asigna junto al
  nombre, el selector y los filtros. El QuickAdd al pie de cada columna (que la
  misma 9.3 pide como componente aparte) ya cubre la intención, y la cubre mejor:
  crear desde la cabecera obligaría a elegir la columna en un formulario, mientras
  que escribir al pie de una columna ya la eligió. Dos caminos para lo mismo, uno
  peor. De las otras dos, el nombre y los filtros están en BoardHeader. El
  SELECTOR de tablero está, pero en `BoardSidebar` y no en la cabecera: la barra
  ya era la lista de tableros, y un selector es esa lista pulsable; en la cabecera
  habría que esconder los otros tableros detrás de un desplegable para ahorrar un
  ancho que la barra ya ocupa.

- **Sin buscador libre en la UI.** El capítulo 9 no lo pide, así que esto no se
  desvía de ningún requisito; se declara igual porque la capacidad SÍ existe
  debajo —`GET /api/tasks/search` y la herramienta `search_tasks`— y su ausencia
  arriba se lee como un olvido. El motivo es que hoy se leería como roto: la
  búsqueda full-text no es incremental (`plainto_tsquery` no agrega `:*`, así que
  un prefijo no encuentra nada mientras se escribe) y no tolera acentos de forma
  uniforme (ver las dos entradas de deuda correspondientes). Disparador: entra
  cuando entre `unaccent` en la configuración de búsqueda.

- **Sin editar tableros desde la UI.** La 3 del funcional pone "crear, listar,
  editar" para los tableros, y el RF-01 pide crearlos "indicando nombre y
  descripción opcional". La UI los crea y los lista, y los crea sin descripción;
  editar el nombre o la descripción de un tablero se hace por la API
  (`PATCH /api/boards/{id}`), y el catálogo MCP de la 8.2 no trae herramienta
  para eso. El motivo: la descripción de un tablero no se muestra en ningún sitio
  de esta UI, así que pedirla o editarla sería escribir un dato que la pantalla
  no usa; renombrar un tablero pasa pocas veces en uso personal; y el capítulo 9
  no le asigna esa acción a ningún componente. Disparador: que la UI muestre la
  descripción, o que renombrar se vuelva frecuente.

- **La entidad Proyecto es post-MVP.** La 2 del funcional la nombra como objetivo
  ("permitir múltiples tableros y proyectos sin introducir complejidad innecesaria
  en el MVP") y el modelo de datos no la tiene. El motivo es que un proyecto sin
  permisos ni miembros es solo una carpeta: lo que le da sentido es agrupar
  tableros de gente distinta, o sea que el disparador real es el MULTIUSUARIO, no
  el número de tableros. Cuando llegue es ADITIVO y no una migración dolorosa:
  `board_id` sigue siendo la referencia estable de tareas, columnas, herramientas
  MCP y auditoría, y un proyecto se cuelga por encima del tablero.

- **Sin UI de gestión de API keys.** La 7.1 define las claves y su ciclo de vida;
  se emiten por CLI (`pnpm run apikey:create`) y se revocan tipeando SQL. Una
  pantalla que las emita, las liste y las revoque necesita antes una pantalla de
  AJUSTES que no existe —hoy la UI es una sola página, el tablero— así que sería
  inventar una sección entera para un uso que en un sistema personal ocurre dos
  veces. Disparador: el día que esto se le entregue a alguien más, porque ahí
  emitir una clave deja de ser una tarea de quien administra la máquina.

- **La UI NO TIENE AUTENTICACIÓN.** Quien llega al puerto de la aplicación lee y
  escribe todo sin clave: `GET /` sirve todos los tableros con sus títulos y
  fechas, `?tarea=` agrega la descripción (las dos medidas con `curl` sin cabecera
  `Authorization`: 200 y los datos en el HTML), y las Server Actions crean,
  editan, mueven y borran sin clave ni scopes (7.2). De paso quedan fuera el
  límite de la 7.3, que se cobra por clave dentro de `conAuth`, y el `client_id`
  de la auditoría: la UI escribe como USER con `client_id` NULL. `/eventos` no
  agrega exposición a eso. El motivo: es un sistema personal en un contenedor, y
  la UI invoca los servicios en el mismo proceso y no consume su propia API
  pública (9.1), así que no tiene clave que presentar ni a quién presentársela.
  OJO, la especificación se contradice sola en este punto. La ADR-005 (2.5) dice
  que "la sesión de la UI web usa el mismo mecanismo mediante una clave de
  servidor que nunca llega al navegador"; la 7.3 dice que "los Server Components
  y las Server Actions invocan el núcleo directamente en el servidor", y no nombra
  ninguna clave. El repo sigue a la 7.3 y a la 9.1, y por eso el CT-08 no tiene
  superficie en la UI (ver el mapa CT). Disparador: que el puerto de la
  aplicación sea alcanzable por alguien más que quien administra la máquina.
  PRECISIÓN DEL DISPARADOR, decidida el 14 de septiembre de 2026 al empezar F4:
  el puerto NO se expone a internet, y el "cliente remoto" de la 8.1 NO lo
  dispara. Ese cliente es un cliente MCP que no es el proceso stdio local —otra
  máquina en la red del usuario, o el mismo host—, no un servicio público. Abrir
  `/mcp` a internet abriría con él `GET /`, las Server Actions y `/eventos`, que
  no autentican por este desvío: exponerlo no es un paso de F4, es el
  disparador. El día que el producto se venda eso cambia, y arrastra la UI
  entera con él.

- **Sin el aislamiento de pruebas de la 10.3**, que pide "un esquema PostgreSQL
  propio, creado y destruido en el ciclo de vida de la suite, para permitir
  paralelismo sin interferencias". El repo usa UNA base compartida, `TRUNCATE` en
  cada `beforeEach`, `fileParallelism: false` y `maxWorkers: 1`. Es ANTERIOR a F3
  y nunca se decidió explícitamente: se llegó por el camino simple y funciona. Lo
  que se paga es tiempo de pared —las suites no pueden correr en paralelo— y lo
  que se gana es que no hay que crear ni destruir esquemas. Disparador: que la
  corrida de `verify` moleste de verdad.
  OJO, la otra mitad de la 10.3 SÍ está: el script de siembra determinista
  invocable con una semilla fija existe (`apps/web/e2e/semilla.ts`, una semilla
  por clave de `SEMILLAS`), y de él parten las pruebas de extremo a extremo.

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
  con

  ```
  grep -rn "<lo que viste>" apps packages --include=*.ts \
    --exclude-dir=node_modules --exclude-dir=generated --exclude-dir=.next \
    --exclude-dir=.next-humo --exclude-dir=.next-e2e
  ```

  Ya engañó una vez, con un título de TAREA leído como nombre de tablero. NO
  filtra por `*.test.ts`, y es a propósito: la última suite que corre es la de
  extremo a extremo, que parte de la siembra de la 10.3 —trunca y siembra igual—,
  y los textos de esa siembra viven en `apps/web/e2e/semilla.ts` y `base.ts`, que
  no son archivos de prueba. Este
  archivo mandaba antes un `--include=*.test.ts` que, con ese residuo, no
  devolvía nada.
- Eso incluye `api_key`: verify también la vacía, así que cualquier clave
  emitida a mano desaparece en el próximo verify y hay que reemitirla con
  `pnpm run apikey:create`.
- Los scripts de package.json deben ser multiplataforma: nada de `rm`, `cp`,
  `export` ni here-docs.
- `apps/web` corre con TURBOPACK, que es el default de `next`: sus scripts de
  `dev` y `build` no llevan flag de bundler. Se llegó ahí migrando los
  specifiers del estilo NodeNext (`./x.js` apunta a `x.ts`) a specifiers SIN
  extensión, en cinco pasos y de a un paquete por vez, porque lo sin-extensión
  es lo único que resuelven las cuatro herramientas del proyecto a la vez.
  Antes eso lo tapaba `experimental.extensionAlias`, que sólo implementa
  webpack, y por eso los scripts forzaban ese bundler con su flag; ya no queda
  ni la opción ni el flag.

  Lo que NO hay que leer como pendiente: los `.js` que quedan son de tres
  clases y ninguna se migra. Subpaths REALES de un paquete
  (`@modelcontextprotocol/sdk/types.js` y los otros cinco son archivos `.js`
  publicados, de 1,7 a 73 KB; sacarles la extensión rompe el import), archivos
  reales en disco (`../dist/index.js`, el bundle de esbuild, y
  `../package.json`), y la extensión `.ts` DELIBERADA de
  `core/scripts/create-api-key.mjs`, que es obligatoria. Antes de tocar
  cualquiera, comprobá contra el disco a qué resuelve; el nombre no alcanza.

  Que no vuelva a entrar un specifier con extensión donde no va:

  ```
  grep -rnoE '"[.][.]?/[^"]*[.]js"' . --include=*.ts --include=*.tsx \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.next-humo \
    --exclude-dir=.next-e2e --exclude-dir=generated
  ```

  Pide `./` o `../` al principio y la comilla de cierre al final a propósito:
  sin lo primero cuenta los subpaths de paquete, que son legítimos, y sin lo
  segundo `.js` también matchea dentro de `"../package.json"`. Hoy la única
  línea que devuelve son los dos `../dist/index.js` de `apps/mcp-stdio`.

  La lista de `--exclude-dir` tiene que llevar TODOS los distDir, no sólo
  `.next`: `next build` genera un `types/validator.ts` lleno de specifiers
  `"../../app/…/route.js"` que son legítimos y generados, y catorce líneas de
  ruido tapan la que importa. `.next-e2e` entró por eso cuando se montó
  Playwright; si aparece otro distDir, va también acá.
- El navegador de Playwright NO está en el repo y `pnpm install` NO lo baja: un
  clon nuevo necesita, una vez,

  ```
  pnpm --filter @taskman/web exec playwright install chromium
  ```

  Son ~115 MB que van a `%LOCALAPPDATA%\ms-playwright`, FUERA del repo y
  compartidos con cualquier otro proyecto de la máquina, así que puede que ya
  estén. No se enganchó a un `postinstall` a propósito: descargar cien megas en
  cada `pnpm install` para una suite que quizá no se corra es peor que el
  mensaje que da Playwright cuando falta, que dice exactamente qué comando
  correr.
- `pnpm run e2e` compila con `next build` en su PROPIO distDir (`.next-e2e`) y lo
  sirve con `next start`, nunca con `next dev`. Los tres motivos, en orden de
  importancia: mide lo que se publica —dev inyecta 6 KB de cliente de HMR y la
  superposición de errores en el mismo documento, y hay pruebas que miden
  ALTURAS renderizadas—; `next start` no crea el candado `lock` que vive dentro
  del distDir y que ya mordió al humo; y arranca en 1,4 s contra los 6,4 s de
  dev, con el primer GET / en 0,17 s contra 3,08 s (medido). El distDir propio
  es porque el `.next` del desarrollador puede ser una compilación de dev, y
  `next start` sobre eso no arranca.

  Eso NO reemplaza a `humo:dev`, que sigue siendo lo único que levanta
  `next dev`: el fallo del runtime edge de `instrumentation.ts` sólo se ve ahí.
  Los dos están en verify y cubren cosas distintas.

  Efecto colateral que confunde: `next build` REESCRIBE `next-env.d.ts` para que
  importe los tipos del distDir que acaba de compilar, así que después de un e2e
  ese archivo nombra `.next-e2e` y después de un `build` normal nombra `.next`.
  Está gitignoreado, no genera churn, y borrar el distDir al que apunta no rompe
  el typecheck (comprobado: `tsc --noEmit` sale 0 sin `.next-e2e` en disco). No
  es un archivo que haya que "arreglar" cuando se lo ve cambiado.
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
  `Prisma.Sql` devuelve 200 en dev, que es donde aparecería el 42601. OJO con esa
  frase: es una MEDICIÓN y no una propiedad, y estuvo cuatro commits siendo falsa
  sin que nadie se enterara —desde 2518c5f `next dev` devolvía 500 en TODA
  petición, por lo que cuenta la entrada del runtime edge de más abajo—. La
  vuelve a medir `pnpm run humo:dev` en cada verify; hasta ahora no la medía
  nada, porque nada del pipeline levantaba `next dev`.
  `pino` entró por lo mismo con el log de la 11.1, y se comprobó igual: una sola
  copia física vista desde `apps/web` y `apps/mcp-stdio` —el mismo realpath, no el
  mismo número de versión— y después `next build` más `next start` con
  GET /api/health devolviendo 200 y escribiendo su línea JSON, que es donde se
  vería si el bundler lo hubiera partido.
  Pendiente conocido: `@prisma/adapter-pg` SIGUE inerte y se empaqueta. Hoy no
  rompe nada —el bug era específico del runtime de `@prisma/client`— y el arreglo
  sería idéntico.
  El caso CONTRARIO, que el realpath no ve: `@modelcontextprotocol/sdk` resuelve
  desde `apps/web` y NO está en la lista, a propósito. Declararlo no sería inerte:
  duplicaría zod en tiempo de ejecución —UNA copia física, DOS instancias, porque
  Node carga el SDK con su zod nativa y el núcleo usa la empaquetada—. La medición
  está en el comentario de `serverExternalPackages` en `next.config.ts`. Para
  diagnosticar dos zod, `instanceof` NO sirve —en zod 4 compara traits y da true
  igual—: solo `===` sobre la clase.
- `instrumentation.ts` se compila TAMBIÉN para el runtime EDGE, donde no existe
  `fs` y donde `serverExternalPackages` NO aplica. O sea que nada de lo que ese
  archivo importe, ni directa ni transitivamente, puede terminar en `pg` o en
  Prisma. Pasó: `lib/config.ts` pedía cuatro símbolos puros al BARREL de
  `@taskman/core` y se traía los repositorios con ellos, así que `next dev`
  devolvía 500 en TODA petición con `Module not found: Can't resolve 'fs'`
  mientras `next build` seguía en verde —sin rutas edge no emite ese bundle— y
  `verify` no lo veía. La salida fue el subcamino `@taskman/core/logger`, que
  apunta a un módulo HOJA. La regla para cuando F3 agregue imports: lo que
  cuelgue de `instrumentation.ts` pide al núcleo por un subcamino sin
  dependencias, nunca por `"."`. Lo detecta `pnpm run humo:dev`.
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
  nativo de Node, que exige el specifier COMPLETO del ESM y no resuelve los
  imports sin extensión del núcleo (`./x` -> `x.ts`), así que un solo import
  interno lo rompe. (Antes la razón era la contraria —los specifiers eran
  NodeNext y lo que Node no hacía era la sustitución `./x.js` -> `x.ts`—: la
  regla sobrevivió al cambio con el motivo invertido, así que no la releas al
  revés.) Se comparte en vez de recalcular el hash en el script porque, si los
  dos difirieran, se emitirían claves que no validan y el síntoma sería un 401
  indistinguible de una clave mal tipeada. Consecuencia: ese comando requiere
  Node 22.6+, por encima del Node 20+ que declara el resto del proyecto; afecta
  solo al script, no a la app. Si algún día hace falta importar algo ahí, la
  salida es empaquetar el script con esbuild como `apps/mcp-stdio`, no relajar
  la regla.
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

- El registro de herramientas, `TaskManagerPort` y el MONTAJE viven en
  `packages/core/mcp`, pero el nucleo NO importa el SDK de MCP: las herramientas
  se declaran como dato (`McpToolDefinition`) y `montarHerramientas`
  (`montaje.ts`) las registra sobre un servidor descrito por su FORMA
  (`ServidorDeHerramientas`), en el que el `McpServer` del SDK encaja por tipado
  estructural. Cada app solo construye su `McpServer` y su transporte. Es lo que
  hace compatibles la regla de dependencias de arriba con el "registro unico" de
  la 8.1 y la ADR-003: el bucle vivia en `apps/mcp-stdio`, `apps/web` no puede
  importarlo, y duplicarlo en /mcp era tener dos traducciones de la definicion al
  protocolo. Ese encaje depende de que `McpToolResult` y `McpTextContent` sean
  `type` y no `interface`: el resultado del SDK tiene firma de indice, y una
  interface no se le asigna sin cast.
- /mcp NO TIENE SESION (D4): cada POST arma su `McpServer` y su transporte
  (`WebStandardStreamableHTTPServerTransport`, con `enableJsonResponse`) y los
  cierra al responder; GET y DELETE dan 405. Asi los scopes se leen de la clave
  en CADA mensaje. Por eso `actor_name` es la ETIQUETA de la clave y no el
  `clientInfo.name` del initialize, que ese servidor nunca vio; `client_id` es el
  prefijo y `request_id` el del X-Request-Id de la peticion (`contextoDeMcp`).
- El LIMITE DE PETICIONES de /mcp cobra POR MENSAJE, en el cupo de la
  HERRAMIENTA (D5, `cuposDeMensajes`): un `tools/call` a una de `write` o `delete`
  cobra escritura, todo lo demas lectura, con la misma `CUBO_POR_SCOPE` de REST.
  Por eso el cuerpo se lee ANTES de cobrar, al reves que `conAuth`. Un lote
  JSON-RPC cobra un lugar por mensaje, y una herramienta que la clave no tiene
  igual cobra su cupo. Consecuencia de producto medida: el ejemplo 5 del Anexo A
  entra JUSTO con 30 move_task por minuto; el 31 recibe 429.
- ORIGIN: /mcp rechaza con 403 FORBIDDEN_ORIGIN toda peticion que TRAIGA `Origin`,
  antes de autenticar, y deja pasar la que no lo trae, que es la de cualquier
  cliente que no sea un navegador. No hay lista permitida ni variable: no existe
  cliente de navegador, y el dia que exista entra junto con la lista de CORS de
  la 7.3. No se usa el `allowedOrigins` del SDK, que esta `@deprecated`.
- Un fallo no controlado de una herramienta NO expone la causa en NINGUN
  transporte: la respuesta lleva INTERNAL_ERROR y el `request_id`, y la traza va
  a la linea `mcp.tool` (campo `err`). Todo error MCP lleva `request_id`, porque
  `respuestaError` lo exige como argumento.
- La resolucion por nombre de la 8.3.1 esta en `packages/core/src/mcp/resolve.ts`
  y es UNA sola para tablero, columna y tarea. Si hace falta una regla distinta
  para alguna entidad, va como dato en el ambito, no como un `if` en el modulo.
- El ambito de una resolucion por titulo es SIEMPRE un tablero, nunca global.
  Por eso `board` es obligatorio en `move_task` cuando la tarea viene por
  titulo.
- Una coincidencia ambigua NUNCA se resuelve eligiendo la primera. Devuelve
  AMBIGUOUS_MATCH con todos los candidatos y un `hint` que dice que hacer.
- Un `McpServer` atiende a UNA sola clave. Los scopes entran al montar
  (`OpcionesRegistro.scopes`, obligatorio) y `crearHerramientas` devuelve solo
  las herramientas que alcanzan, asi que el filtrado de la 8.1 vive en la
  instancia: reusar un servidor entre clientes le ofrece a cada uno el catalogo
  del primero. Scopes y MCP_DESTRUCTIVE_POLICY son filtros INDEPENDIENTES y no
  comparten mecanismo: el de scopes OMITE —el SDK responde "not found"— y el de
  la politica MARCA `anunciada: false` —el SDK responde "disabled"—. Llevar los
  scopes a `anunciada` es la forma de que uno deshaga al otro.
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