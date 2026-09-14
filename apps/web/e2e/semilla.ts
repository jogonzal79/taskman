import { randomUUID } from "node:crypto";

import {
  crearCorePort,
  type ActorContext,
  type CorePort,
  type Priority,
} from "@taskman/core";
import { Client } from "pg";

/**
 * La SIEMBRA DETERMINISTA que pide la 10.3: "Existe un script de siembra
 * determinista, invocable con una semilla fija, que genera un tablero con las
 * cuatro columnas y un conjunto conocido de tareas; las pruebas de extremo a
 * extremo parten siempre de ese estado."
 *
 * No existia hasta este paso. Vive en `apps/web/e2e` porque hoy el unico que
 * parte de ese estado es Playwright; el dia que otra superficie lo necesite,
 * sube de sitio sin cambiar de forma.
 *
 * QUE SIGNIFICA "SEMILLA FIJA" ACA. No hay generador pseudoaleatorio ni numero
 * que lo alimente: las semillas son DATOS LITERALES, escritos abajo, y `sembrar`
 * los escribe tal cual. Es una forma mas fuerte de determinismo que un PRNG con
 * seed —no depende de la implementacion del generador ni de la version de Node—
 * y ademas hace que las aserciones importen las MISMAS constantes que se
 * sembraron, en vez de repetir a mano lo que se espera ver. Lo que se fija es el
 * NOMBRE de la semilla, que es una de las claves de `SEMILLAS`.
 *
 * LO UNICO QUE NO ES LITERAL son dos cosas, las dos inevitables:
 *
 *   - Los UUID. Los genera la aplicacion dentro del nucleo (invariante del
 *     proyecto) y no hay forma de inyectarlos. No importa: nada de lo que se
 *     afirma en pantalla es un id.
 *   - Las FECHAS, que van como DESPLAZAMIENTO EN DIAS respecto de hoy y no como
 *     literales. Una fecha literal futura deja de ser futura sola, y el dia que
 *     eso pasara la prueba de "vencida" empezaria a fallar por el calendario y
 *     no por el codigo. El desplazamiento se resuelve contra el dia UTC, que es
 *     la misma zona en la que compara `esVencida` (`domain/vencimiento.ts`).
 *
 * SIEMBRA POR EL NUCLEO, no en SQL crudo: `createBoard` y `createTask` son el
 * mismo camino que usan los Route Handlers y las herramientas MCP, asi que el
 * orden denso, las cuatro columnas por defecto (4.3) y el registro de auditoria
 * salen solos. Escribir las filas a mano seria reimplementar la 5.2 en la
 * siembra, que es justo la clase de copia que despues discrepa.
 */

// --- Guarda de la base -------------------------------------------------------

/**
 * La misma guarda de `test/helpers.ts`, copiada ENTERA y a proposito: es lo unico
 * que impide que el TRUNCATE de abajo caiga sobre una base que no es la de docker
 * compose. Los helpers de prueba de un paquete no son API publica —por eso las
 * copias que ya hay en el repo— pero esta guarda vale mas repetida que ausente.
 */
function exigirBaseLocal(): string {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.trim() === "") {
    throw new Error(
      "DATABASE_URL no esta definida. Copia .env.example a .env en la raiz del repo.",
    );
  }

  const { hostname } = new URL(url);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(
      `La siembra de extremo a extremo vacia las tablas con TRUNCATE. DATABASE_URL debe apuntar a la base local de docker compose, pero apunta a "${hostname}".`,
    );
  }

  return url;
}

/**
 * `api_key` e `idempotency_record` entran por lo mismo que en `test/helpers.ts`:
 * ninguna cuelga por CASCADE de las otras tres y las dos sobreviven a la corrida
 * que las creo. La siembra no emite claves —la UI no se autentica— pero dejar
 * filas de la suite de contrato no aporta nada y confunde al mirar la base.
 */
const TABLAS = [
  "task",
  "board_column",
  "board",
  "audit_log",
  "api_key",
  "idempotency_record",
] as const;

// --- Forma de una semilla ----------------------------------------------------

/** Una tarea de la semilla, tal como se va a ver en la tarjeta. */
export interface TareaSembrada {
  readonly title: string;
  /**
   * Omitida, la tarea se crea con `description` NULL, que es lo que hace el
   * QuickAdd. Se declara en las pocas que la necesitan: el panel de detalle la
   * EDITA, y para probar que vaciarla la borra hace falta una que la tenga, igual
   * que para probar que editar otro campo la deja intacta.
   */
  readonly description?: string;
  readonly priority: Priority;
  /**
   * Dias respecto de HOY (UTC). Negativo es pasado, `0` es hoy, positivo futuro,
   * `null` es sin fecha limite. Ver arriba por que no son literales.
   */
  readonly vence: number | null;
}

/** Una columna de la semilla: su key de la 4.3 y sus tareas EN ORDEN. */
export interface ColumnaSembrada {
  readonly key: string;
  /** El nombre que la 4.3 le da a esa key. Se afirma en pantalla. */
  readonly name: string;
  /** En orden de posicion 0..n-1: se crean una tras otra, al final. */
  readonly tareas: readonly TareaSembrada[];
}

export interface TableroSembrado {
  readonly name: string;
  readonly columnas: readonly ColumnaSembrada[];
}

export interface Semilla {
  /**
   * TODOS los tableros que va a haber, en el orden en que la barra lateral los
   * va a listar. El nucleo ordena por `name` ascendente (`ORDEN_BOARD`) y el
   * PRIMERO es el que muestra `/` a secas, sin `?tablero=` (`cargarVista` en
   * lib/tablero.ts).
   */
  readonly tableros: readonly TableroSembrado[];
}

/** El tablero que muestra `/`: el primero del listado. */
export function tableroActivo(semilla: Semilla): TableroSembrado {
  const primero = semilla.tableros[0];

  if (primero === undefined) {
    throw new Error("La semilla no tiene ningun tablero.");
  }

  return primero;
}

/** Un tablero de la semilla, por nombre. */
export function tableroSembrado(semilla: Semilla, nombre: string): TableroSembrado {
  const tablero = semilla.tableros.find((candidato) => candidato.name === nombre);

  if (tablero === undefined) {
    throw new Error(`La semilla no tiene el tablero ${nombre}.`);
  }

  return tablero;
}

/** Los titulos de un tablero en el orden en que se pintan: columna por columna. */
export function titulosSembrados(tablero: TableroSembrado): string[] {
  return tablero.columnas.flatMap((columna) => columna.tareas.map((tarea) => tarea.title));
}

/** Una columna del tablero, por key. */
export function columnaDe(tablero: TableroSembrado, key: string): ColumnaSembrada {
  const columna = tablero.columnas.find((candidata) => candidata.key === key);

  if (columna === undefined) {
    throw new Error(`La semilla no tiene la columna ${key}.`);
  }

  return columna;
}

// --- Las semillas ------------------------------------------------------------

/**
 * Los cuatro nombres de la 4.3, escritos aca y NO leidos de
 * `COLUMNAS_POR_DEFECTO`: lo que la pantalla tiene que mostrar es la tabla de la
 * 4.3, y leerlo de la misma constante que lo produce haria que la prueba pasara
 * igual si esa constante cambiara. Mismo criterio por el que
 * `packages/contracts` reescribe sus limites en vez de importarlos del nucleo.
 */
const BACKLOG = "Backlog";
const POR_HACER = "Por hacer";
const EN_PROGRESO = "En progreso";
const COMPLETADO = "Completado";

/**
 * Un titulo LARGO de verdad: tiene que necesitar mas de dos lineas en una columna
 * de 288 px con cualquier fuente de sistema razonable, porque de eso depende que
 * la prueba del recorte mida un recorte y no una coincidencia. A 14 px entran del
 * orden de 35 caracteres por linea, asi que estos 174 piden cinco.
 *
 * El tope de arriba es `LIMITE_TITULO`, 200: un titulo mas largo lo rechaza el
 * dominio y la siembra falla antes de llegar a la pantalla. Paso al escribir
 * esto: el primer titulo que se probo tenia 217 y la siembra murio con
 * NAME_TOO_LONG antes de que el navegador abriera nada.
 */
export const TITULO_LARGO =
  "Documentar el procedimiento completo de migracion con create-only, incluyendo el borrado manual de cada DROP que Prisma propone sobre las restricciones de SQL crudo de la 4.2";

/** Y uno corto, que tiene que entrar en UNA sola linea. Es el otro lado de la medida. */
export const TITULO_CORTO = "Cerrar sesion";

/** Vencida y FUERA de DONE: lleva marca. */
export const TITULO_VENCIDA_FUERA = "Responder el correo de soporte";

/** Vencida y DENTRO de DONE: NO lleva marca. Es el invariante del paso anterior. */
export const TITULO_VENCIDA_EN_DONE = "Cerrar el tablero en modo lectura";

/** Vence HOY, que para `esVencida` todavia NO es vencida. El borde de la regla. */
export const TITULO_VENCE_HOY = "Revisar el plan de la fase 3";

export const TITULO_URGENTE = "Cortar la release de la version 1.0";
export const TITULO_ALTA = "Migrar el indice de busqueda a pg_trgm";
export const TITULO_MEDIA = "Revisar el contrato OpenAPI";
export const TITULO_BAJA = "Ordenar el backlog por valor";

/**
 * Las DOS descripciones sembradas. Son las unicas tareas con `description` no
 * nula, y estan puestas para el panel de detalle: una para comprobar que vaciar
 * el campo BORRA, y otra para comprobar que editar OTRO campo la deja intacta.
 * Las dos mitades de la distincion ausente-vs-null necesitan un valor previo.
 */
export const DESCRIPCION_DE_SOPORTE = "Hay que contestarle antes del viernes.";
export const DESCRIPCION_DE_CONTRATO = "Comparar openapi.json con la tabla de la 6.3.";

/**
 * El SEGUNDO tablero de `principal` y sus dos tareas. Los titulos no aparecen en
 * el primero a proposito: una tarjeta en pantalla tiene que decir sin ambiguedad
 * de que tablero es, porque lo que se prueba con ellas es justamente que un
 * enlace no te haya devuelto al otro.
 *
 * Una de cada prioridad que importa para el filtro: con "Alta" puesto, este
 * tablero muestra una y esconde la otra, asi que el filtro se ve actuar.
 */
export const TABLERO_OTRO = "2 Otro tablero";
export const TITULO_OTRO_ALTA = "Reservar la sala para la demo";
export const TITULO_OTRO_MEDIA = "Elegir el nombre del segundo proyecto";

/**
 * Las cuatro columnas de la 4.3 sin tareas. Base de todas las semillas: asi la
 * diferencia entre `principal` y `vacio` es exactamente el contenido, y ninguna
 * puede quedarse sin una columna por descuido.
 *
 * Se exporta porque ES LA TABLA DE LA 4.3 escrita a mano, key, nombre y orden, y
 * eso es exactamente contra lo que el CT-01 compara un tablero creado desde la
 * pantalla (por SQL, con la position como indice de esta lista).
 */
export function columnasVacias(): ColumnaSembrada[] {
  return [
    { key: "BACKLOG", name: BACKLOG, tareas: [] },
    { key: "TODO", name: POR_HACER, tareas: [] },
    { key: "IN_PROGRESS", name: EN_PROGRESO, tareas: [] },
    { key: "DONE", name: COMPLETADO, tareas: [] },
  ];
}

function conTareas(
  porKey: Readonly<Record<string, readonly TareaSembrada[]>>,
): ColumnaSembrada[] {
  return columnasVacias().map((columna) => ({
    ...columna,
    tareas: porKey[columna.key] ?? [],
  }));
}

/**
 * Las semillas fijas.
 *
 * Los nombres de tablero empiezan por un DIGITO distinto y no por letra: el orden
 * de la barra lateral sale de un `ORDER BY name::text` en PostgreSQL, y entre "1"
 * y "2" ninguna intercalacion discrepa. Con nombres que difirieran en un acento o
 * en mayusculas, cual tablero se muestra dependeria de la configuracion de la
 * base, que es justo lo que una semilla determinista no puede permitirse.
 */
export const SEMILLAS = {
  /**
   * El caso normal: un tablero con las cuatro columnas y tareas conocidas en cada
   * una, mas un SEGUNDO tablero con dos tareas propias. `/` muestra el primero;
   * al segundo se llega desde la barra lateral, y es el que prueba que el
   * selector lleva a otro tablero y que ningun enlace devuelve al primero.
   */
  principal: {
    tableros: [
      {
        name: "1 Tablero sembrado",
        // El orden de cada lista ES el orden que se espera en pantalla.
        columnas: conTareas({
          BACKLOG: [
            {
              title: TITULO_MEDIA,
              description: DESCRIPCION_DE_CONTRATO,
              priority: "MEDIUM",
              vence: null,
            },
            { title: TITULO_URGENTE, priority: "URGENT", vence: null },
            { title: TITULO_ALTA, priority: "HIGH", vence: null },
            { title: TITULO_BAJA, priority: "LOW", vence: null },
          ],
          TODO: [
            { title: TITULO_LARGO, priority: "MEDIUM", vence: null },
            { title: TITULO_CORTO, priority: "MEDIUM", vence: null },
            {
              title: TITULO_VENCIDA_FUERA,
              description: DESCRIPCION_DE_SOPORTE,
              priority: "MEDIUM",
              vence: -3,
            },
            { title: TITULO_VENCE_HOY, priority: "MEDIUM", vence: 0 },
          ],
          IN_PROGRESS: [{ title: "Montar Playwright", priority: "HIGH", vence: 5 }],
          // La fecha de la vencida en DONE es OTRA a proposito: con la misma que
          // TITULO_VENCIDA_FUERA, el par se podria leer como una sola tarea.
          DONE: [
            { title: TITULO_VENCIDA_EN_DONE, priority: "MEDIUM", vence: -10 },
            { title: "Pasar a Turbopack", priority: "LOW", vence: null },
          ],
        }),
      },
      {
        name: TABLERO_OTRO,
        columnas: conTareas({
          BACKLOG: [{ title: TITULO_OTRO_MEDIA, priority: "MEDIUM", vence: null }],
          TODO: [{ title: TITULO_OTRO_ALTA, priority: "HIGH", vence: null }],
        }),
      },
    ],
  },

  /**
   * Un tablero recien creado: las cuatro columnas de la 4.3 y ninguna tarea. Es
   * el estado en el que queda un tablero despues de `create_board`, o sea el
   * primero que ve cualquiera, y por eso tiene su propia semilla en vez de ser
   * una columna vacia dentro de la otra.
   */
  vacio: {
    tableros: [{ name: "1 Tablero recien creado", columnas: columnasVacias() }],
  },

  /**
   * NINGUN tablero: la base recien migrada, antes de que nadie cree nada. Es el
   * unico estado desde el que el primer tablero solo se puede crear en la barra
   * lateral, porque no hay otro sitio de la pantalla que se dibuje. Una semilla
   * con esto no tiene tablero ACTIVO, y la fixture lo resuelve al pedirlo (ver
   * `sembrado` en `tablero.ts`).
   */
  ninguno: {
    tableros: [],
  },
} as const satisfies Record<string, Semilla>;

export type NombreDeSemilla = keyof typeof SEMILLAS;

// --- Escritura ---------------------------------------------------------------

/** Medianoche del dia UTC de `hoy`, mas `dias`. Misma lectura que `esVencida`. */
export function fechaRelativa(hoy: Date, dias: number): Date {
  return new Date(
    Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + dias),
  );
}

function contexto(): ActorContext {
  return { actorType: "API", actorName: "siembra e2e", requestId: randomUUID() };
}

/**
 * El puerto se construye UNA vez por proceso, como en los Route Handlers: detras
 * hay un `PrismaClient` y construir uno por siembra abriria un pool por prueba.
 */
let puerto: CorePort | undefined;

function corePort(): CorePort {
  puerto ??= crearCorePort();
  return puerto;
}

/**
 * Vacia las seis tablas y escribe la semilla. Devuelve la semilla, para que la
 * prueba afirme contra lo mismo que se escribio.
 *
 * VACIA SIEMPRE, aunque la base ya estuviera vacia: lo que pide la 10.3 es partir
 * de un estado conocido, no de uno compatible. Y se invoca antes de CADA prueba y
 * no una vez por corrida, que es la unica forma de que una prueba no pueda
 * depender de lo que dejo la anterior.
 *
 * `hoy` ENTRA, no se lee aca dentro: quien afirma sobre las fechas tiene que
 * poder resolver los desplazamientos contra el MISMO instante con el que se
 * escribieron. Leyendolo dos veces, una siembra a las 23:59:59.9 UTC y una
 * asercion a las 00:00:00.1 discreparian en un dia, una vez cada tantos meses y
 * sin dejar rastro de por que.
 */
export async function sembrar(nombre: NombreDeSemilla, hoy: Date): Promise<Semilla> {
  const semilla: Semilla = SEMILLAS[nombre];
  const cliente = new Client({ connectionString: exigirBaseLocal() });
  await cliente.connect();

  try {
    await cliente.query(
      `TRUNCATE TABLE ${TABLAS.map((tabla) => `"${tabla}"`).join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await cliente.end();
  }

  const taskman = corePort();

  for (const tablero of semilla.tableros) {
    // Sin `columns`: asi las cuatro columnas salen de la 4.3 y no de esta lista,
    // que es lo que hace que la prueba de "las cuatro columnas" mida algo.
    const creado = await taskman.createBoard({ name: tablero.name }, contexto());

    for (const columna of tablero.columnas) {
      for (const tarea of columna.tareas) {
        // Sin `position`: cada una va al final, asi que el orden de la lista es
        // el orden denso 0..n-1 que la pagina va a pintar.
        await taskman.createTask(
          {
            boardId: creado.id,
            columnKey: columna.key,
            title: tarea.title,
            // Ausente se omite en vez de mandarse en null, que es la misma
            // distincion del PATCH: el servicio pone NULL por defecto, y una
            // clave presente en undefined no es lo mismo que una ausente con
            // `exactOptionalPropertyTypes`.
            ...(tarea.description === undefined ? {} : { description: tarea.description }),
            priority: tarea.priority,
            dueDate: tarea.vence === null ? null : fechaRelativa(hoy, tarea.vence),
          },
          contexto(),
        );
      }
    }
  }

  return semilla;
}
