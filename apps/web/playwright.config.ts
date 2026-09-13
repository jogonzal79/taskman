import { defineConfig } from "@playwright/test";

/**
 * El nivel "Extremo a extremo" de la 10: Playwright sobre un navegador de verdad,
 * contra el tablero de la 9.1 y los datos deterministas de la 10.3
 * (`e2e/semilla.ts`).
 *
 * SE ESTRENA CON UN RENDER ESTATICO. El arrastre es lo mas dificil de automatizar
 * y lo peor para estrenar un runner: si falla, no se sabe si falla el runner o el
 * codigo. Lo que hay hoy o pasa o no pasa.
 *
 * --- Por que `next build` + `next start`, y no `next dev` -------------------
 *
 * MEDIDO en esta maquina, arranque del servidor mas el primer GET / (que en dev
 * incluye compilar la pagina):
 *
 *     next start   socket a los 1.40 s, GET / en 0.17 s   ->  1.59 s   (10,8 KB)
 *     next dev     socket a los 6.37 s, GET / en 3.08 s   ->  9.56 s   (16,6 KB)
 *
 * Seis veces mas rapido, y no es lo principal. Lo principal son otras tres:
 *
 *   - MIDE LO QUE SE PUBLICA. El caso 6 mide ALTURAS renderizadas, y dev sirve
 *     6 KB de mas —cliente de HMR, superposicion de errores— que se inyectan en
 *     el mismo documento. Nada de eso existe en produccion.
 *   - NO HAY CANDADO. El de `next dev` se llama `lock` y vive DENTRO del distDir,
 *     asi que es por directorio y no por puerto; ya mordio una vez a la
 *     comprobacion de humo. `next start` no crea ninguno. Aun asi esta corrida
 *     usa su propio distDir (ver TASKMAN_DIST_DIR abajo), porque el `.next` del
 *     desarrollador puede ser una compilacion de dev, y `next start` sobre eso no
 *     arranca.
 *   - NO TAPA EL DEV. `humo:dev` sigue existiendo y sigue siendo el unico que
 *     levanta `next dev`: el fallo del runtime edge de `instrumentation.ts` solo
 *     se ve ahi. Esta suite NO lo reemplaza; cubre lo contrario, que es la
 *     pagina ya construida.
 *
 * El precio es la compilacion previa: medida en 20 s en frio y 10 s en caliente.
 * La hace `pnpm run e2e`, no esta configuracion, porque Playwright arranca el
 * `webServer` ANTES del `globalSetup` (comprobado) y no hay donde meterla.
 */

/**
 * El distDir de esta corrida. Lo fija `pnpm run e2e` para el build Y para el
 * servidor de abajo, que lo hereda del entorno de este proceso.
 *
 * Se exige en vez de tener valor por defecto: sin el, `next start` serviria el
 * `.next` del desarrollador, que puede ser de otra rama o una compilacion de dev,
 * y la suite mediria algo que nadie construyo en esta corrida. Es mejor un
 * mensaje que un verde sobre el artefacto equivocado.
 */
const DIST_DIR = process.env["TASKMAN_DIST_DIR"];

if (DIST_DIR === undefined || DIST_DIR.trim() === "") {
  throw new Error(
    "TASKMAN_DIST_DIR no esta definida: esta configuracion se invoca con `pnpm run e2e`, que compila y sirve el mismo distDir.",
  );
}

/**
 * Puerto propio, como el de la comprobacion de humo y por lo mismo: si usara
 * 3000, cualquier corrida hecha con el `next dev` del desarrollador abierto
 * fallaria por "address in use". 3988 no es el default de nada conocido y es el
 * siguiente al 3987 del humo.
 */
const PUERTO = Number(process.env["TASKMAN_E2E_PORT"] ?? 3988);
const BASE = `http://127.0.0.1:${PUERTO}`;

export default defineConfig({
  testDir: "./e2e",

  /**
   * DE A UNA. La siembra de la 10.3 vacia la base entera antes de cada prueba,
   * asi que dos pruebas en paralelo se pisarian los datos. Es la misma decision
   * que `fileParallelism: false` en las suites de vitest, y por el mismo motivo:
   * una sola base de desarrollo.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * SIN REINTENTOS. Un reintento convierte una prueba intermitente en una verde
   * ruidosa, y en un nivel que se estrena eso es exactamente lo que hay que poder
   * ver. Si alguna resulta inestable, se arregla, no se reintenta.
   */
  retries: 0,

  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE,
    /**
     * UN SOLO NAVEGADOR, Chromium, sin matriz. Lo que se mide hoy —orden del DOM,
     * cascada de CSS, altura de un recorte de dos lineas— no cambia entre motores
     * de forma que valga tres veces el tiempo de corrida. La matriz se justifica
     * cuando haya algo que dependa del motor, y hoy no lo hay.
     */
    browserName: "chromium",
    /**
     * Por encima del corte de 1024 px de `globals.css`, que es donde vive el
     * tablero. El ancho de columna es fijo (288 px), asi que el recorte del
     * titulo no depende de este numero; el corte por pantalla angosta se prueba
     * cambiando el viewport dentro de su propia prueba.
     */
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  webServer: {
    /**
     * Se invoca el bin de Next con `node`, no `pnpm run start`: un binario menos
     * en la cadena, sin `.cmd` ni shell, que es lo que hace que Playwright pueda
     * matar el arbol al terminar. Mismo criterio que `scripts/humo-dev.mjs`.
     *
     * Sin `dotenv`: las variables ya vienen en el entorno de este proceso, que
     * `pnpm run e2e` arranca con `dotenv -e ../../.env`.
     */
    command: `node node_modules/next/dist/bin/next start --port ${PUERTO}`,
    /**
     * La ruta sin autenticacion de la 6.2, que ademas comprueba la base: hasta que
     * no devuelva 200 no hay nada que probar. Si la base estuviera caida esto
     * agota el timeout en vez de dar un mensaje claro; el motivo aparece en la
     * salida del servidor, que se imprime al fallar.
     */
    url: `${BASE}/api/health`,
    /**
     * NUNCA reusar. Un servidor ya escuchando en ese puerto es de otra corrida y
     * puede estar sirviendo otra compilacion: preferimos fallar por puerto
     * ocupado que medir un artefacto que no es el de esta corrida.
     */
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
