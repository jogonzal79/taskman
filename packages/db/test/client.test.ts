import { afterAll, expect, it } from "vitest";

import { prisma } from "../src/index.js";

afterAll(async () => {
  await prisma.$disconnect();
});

it("el singleton exportado se conecta y ve el esquema migrado", async () => {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('board', 'board_column', 'task', 'audit_log')
     ORDER BY table_name
  `;

  expect(tables.map((row) => row.table_name)).toEqual([
    "audit_log",
    "board",
    "board_column",
    "task",
  ]);
});

it("devuelve siempre la misma instancia", async () => {
  const again = await import("../src/index.js");
  expect(again.prisma).toBe(prisma);
});
