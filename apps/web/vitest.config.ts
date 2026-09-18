import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Calla el log de la 11.1 en toda la suite. Ver test/setup.ts.
    setupFiles: ["./test/setup.ts"],
    /**
     * El limite de la 7.3, APAGADO para toda la suite, que es para lo que la
     * 11.2 declara la variable ("permite desactivar el limite en entornos de
     * prueba").
     *
     * El resto de las suites ejercita los endpoints, no el limite, y varias
     * hacen bastante mas de 30 escrituras por minuto con la misma clave: con el
     * limite encendido dejarian de medir lo que miden y empezarian a medir el
     * cupo, con la fragilidad de un test que depende del reloj. Las que SI
     * ejercitan el limite lo encienden ellas, por prueba, y lo pueden hacer
     * porque el interruptor se lee por peticion y no al importar el modulo.
     *
     * Va en la configuracion y no en los helpers a proposito: asi no depende de
     * que un archivo nuevo se acuerde de importar nada.
     */
    env: { RATE_LIMIT_ENABLED: "false" },
    // Misma base que packages/core y cada test la limpia con TRUNCATE: un solo
    // worker, de a un archivo por vez.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
