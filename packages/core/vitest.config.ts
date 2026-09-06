import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Misma base que packages/db y cada test la limpia con TRUNCATE: un solo
    // worker, de a un archivo por vez. Los tests de concurrencia levantan sus
    // transacciones simultaneas dentro de un mismo test, no entre archivos.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
