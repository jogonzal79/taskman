import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Hay una sola base de pruebas y cada test la limpia con TRUNCATE, asi que
    // la suite corre en un unico worker y de a un test por vez.
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
