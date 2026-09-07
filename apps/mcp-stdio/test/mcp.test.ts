import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BoardRepository,
  BoardService,
  crearCorePort,
  crearHerramientas,
  TransactionRunner,
  type BoardDetail,
} from "@taskman/core";
import { prisma } from "@taskman/db";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { crearServidorMcp } from "../src/server.js";
import { connectDb, truncateAll } from "./helpers.js";

/**
 * El servidor MCP visto como lo ve un agente: por el protocolo, con un cliente
 * real de la SDK sobre un transporte en memoria.
 *
 * Se prueba por el borde y no invocando los handlers a mano porque la mitad de
 * lo que decide si esto sirve pasa en el borde: que las tres herramientas se
 * anuncien con sus esquemas, que cada campo lleve descripcion y que un error de
 * dominio llegue como resultado legible en vez de como excepcion.
 */

let db: PgClient;
let cliente: McpClient;
let tableros: BoardService;

beforeAll(async () => {
  db = await connectDb();
  tableros = new BoardService(new BoardRepository(new TransactionRunner(prisma)));

  const servidor = crearServidorMcp(crearCorePort());
  const [transporteCliente, transporteServidor] = InMemoryTransport.createLinkedPair();
  cliente = new McpClient({ name: "prueba", version: "0.0.0" });
  await Promise.all([servidor.connect(transporteServidor), cliente.connect(transporteCliente)]);
});

afterAll(async () => {
  await cliente.close();
  await prisma.$disconnect();
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- Utilidades del borde ----------------------------------------------------

interface Resultado {
  texto: string;
  json: Record<string, unknown>;
  isError: boolean;
}

/** El bloque JSON de la 8.5 va al final del texto, entre vallas ```json. */
function extraerJson(texto: string): Record<string, unknown> {
  const inicio = texto.indexOf("```json\n");
  const fin = texto.lastIndexOf("\n```");
  if (inicio === -1 || fin <= inicio) {
    throw new Error(`La respuesta no trae bloque JSON:\n${texto}`);
  }
  return JSON.parse(texto.slice(inicio + "```json\n".length, fin)) as Record<string, unknown>;
}

async function llamar(name: string, args: Record<string, unknown>): Promise<Resultado> {
  const salida = await cliente.callTool({ name, arguments: args });
  const bloques = salida.content as Array<{ type: string; text?: string }>;

  expect(bloques).toHaveLength(1);
  const texto = bloques[0]?.text ?? "";

  return { texto, json: extraerJson(texto), isError: salida.isError === true };
}

function error(resultado: Resultado): Record<string, unknown> {
  expect(resultado.isError).toBe(true);
  return resultado.json["error"] as Record<string, unknown>;
}

function detalles(resultado: Resultado): Record<string, unknown> {
  return error(resultado)["details"] as Record<string, unknown>;
}

// --- Siembra -----------------------------------------------------------------

async function sembrarTablero(name = "QA"): Promise<BoardDetail> {
  return tableros.create({ name });
}

async function crear(
  board: string,
  column: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Resultado> {
  const resultado = await llamar("create_task", { board, column, title, ...extra });
  expect(resultado.isError, resultado.texto).toBe(false);
  return resultado;
}

// --- Catalogo ----------------------------------------------------------------

describe("catalogo", () => {
  it("anuncia las tres herramientas de F2.1", async () => {
    const { tools } = await cliente.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_task",
      "list_tasks",
      "move_task",
    ]);
  });

  it("cada campo de cada esquema lleva descripcion", async () => {
    const { tools } = await cliente.listTools();

    // La 8.4 lo exige y no es cosmetico: de la calidad de estas descripciones
    // depende directamente que el agente acierte, asi que un campo sin
    // descripcion tiene que romper la suite, no pasar desapercibido.
    const sinDescripcion: string[] = [];
    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      expect(Object.keys(properties).length).toBeGreaterThan(0);

      for (const [campo, esquema] of Object.entries(properties)) {
        if ((esquema.description ?? "").trim() === "") {
          sinDescripcion.push(`${tool.name}.${campo}`);
        }
      }
      expect((tool.description ?? "").trim()).not.toBe("");
    }

    expect(sinDescripcion).toEqual([]);
  });

  it("los esquemas declaran los campos de la 8.4", async () => {
    const { tools } = await cliente.listTools();
    const campos = (nombre: string): string[] => {
      const tool = tools.find((candidata) => candidata.name === nombre);
      return Object.keys(tool?.inputSchema.properties ?? {}).sort();
    };

    expect(campos("list_tasks")).toEqual(["board", "column", "limit", "overdue", "priority"]);
    expect(campos("move_task")).toEqual(["board", "position", "task", "to_column"]);
    expect(campos("create_task")).toEqual([
      "board",
      "column",
      "description",
      "due_date",
      "position",
      "priority",
      "title",
    ]);

    const move = tools.find((tool) => tool.name === "move_task");
    // `task` y `to_column` son obligatorios; `board` no, porque un id de tarea
    // ya trae su tablero.
    expect((move?.inputSchema.required as string[]).sort()).toEqual(["task", "to_column"]);
  });
});

// --- create_task -------------------------------------------------------------

describe("create_task", () => {
  it("resuelve tablero por nombre y columna por key en una sola llamada", async () => {
    await sembrarTablero("QA");

    const resultado = await crear("QA", "TODO", "Revisar HU-25", {
      priority: "HIGH",
      due_date: "2026-09-11",
    });

    const tarea = resultado.json["task"] as Record<string, unknown>;
    expect(tarea["title"]).toBe("Revisar HU-25");
    expect(tarea["column_key"]).toBe("TODO");
    expect(tarea["position"]).toBe(0);
    expect(tarea["priority"]).toBe("HIGH");
    expect(tarea["due_date"]).toBe("2026-09-11");

    // Texto legible ademas del JSON (8.5): el agente redacta con el primero y
    // encadena con el segundo.
    expect(resultado.texto).toContain('"Revisar HU-25"');
    expect(resultado.texto).toContain("QA / TODO");

    const columna = resultado.json["column"] as Record<string, unknown>;
    expect(columna["task_order"]).toEqual([tarea["id"]]);
  });

  it("resuelve la columna por nombre visible y por la key con espacios", async () => {
    await sembrarTablero("QA");

    const porNombre = await crear("QA", "En progreso", "A");
    const porKeyConEspacios = await crear("QA", "in progress", "B");

    const columnaDe = (r: Resultado): unknown =>
      (r.json["task"] as Record<string, unknown>)["column_key"];
    expect(columnaDe(porNombre)).toBe("IN_PROGRESS");
    expect(columnaDe(porKeyConEspacios)).toBe("IN_PROGRESS");
  });

  it("una key inexistente devuelve COLUMN_NOT_FOUND con las columnas proximas", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_task", {
      board: "QA",
      column: "REVIEW",
      title: "Algo",
    });

    expect(error(resultado)["code"]).toBe("COLUMN_NOT_FOUND");
    expect((detalles(resultado)["suggestions"] as unknown[]).length).toBeGreaterThan(0);
    expect(error(resultado)["hint"]).toContain("suggestions");
  });

  it("un titulo vacio devuelve el error de dominio, no una excepcion", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_task", { board: "QA", column: "TODO", title: "   " });

    expect(error(resultado)["code"]).toBe("TITLE_REQUIRED");
    expect(resultado.texto).toContain("Error TITLE_REQUIRED");
  });

  it("una fecha mal formada se rechaza antes de tocar la base", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_task", {
      board: "QA",
      column: "TODO",
      title: "Con fecha",
      due_date: "11/09/2026",
    });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(detalles(resultado)["field"]).toBe("due_date");
  });
});

// --- Resolucion por nombre (8.3.1) -------------------------------------------

describe("resolucion por nombre", () => {
  it("move_task encuentra la tarea por titulo exacto", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"];

    const resultado = await llamar("move_task", {
      board: "QA",
      task: "revisar hu-25",
      to_column: "IN PROGRESS",
      position: 0,
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    const tarea = resultado.json["task"] as Record<string, unknown>;
    expect(tarea["id"]).toBe(id);
    expect(tarea["column_key"]).toBe("IN_PROGRESS");
    expect(tarea["position"]).toBe(0);

    expect((resultado.json["from_column"] as Record<string, unknown>)["key"]).toBe("TODO");
    expect(resultado.texto).toContain("TODO -> IN_PROGRESS");

    // El orden final de las dos columnas afectadas (5.1 y 8.5).
    const afectadas = resultado.json["affected_columns"] as Array<Record<string, unknown>>;
    expect(afectadas.map((columna) => columna["column_key"]).sort()).toEqual([
      "IN_PROGRESS",
      "TODO",
    ]);
    expect(afectadas.find((c) => c["column_key"] === "IN_PROGRESS")?.["task_order"]).toEqual([id]);
    expect(afectadas.find((c) => c["column_key"] === "TODO")?.["task_order"]).toEqual([]);
  });

  it("un titulo repetido devuelve AMBIGUOUS_MATCH con los dos candidatos y su columna", async () => {
    await sembrarTablero("QA");
    const enTodo = await crear("QA", "TODO", "Revisar HU-25");
    const enDone = await crear("QA", "DONE", "Revisar HU-25");

    const resultado = await llamar("move_task", {
      board: "QA",
      task: "Revisar HU-25",
      to_column: "IN_PROGRESS",
    });

    expect(error(resultado)["code"]).toBe("AMBIGUOUS_MATCH");

    const candidatos = detalles(resultado)["candidates"] as Array<Record<string, unknown>>;
    expect(candidatos).toHaveLength(2);
    expect(candidatos.map((c) => c["id"]).sort()).toEqual(
      [
        (enTodo.json["task"] as Record<string, unknown>)["id"],
        (enDone.json["task"] as Record<string, unknown>)["id"],
      ].sort(),
    );
    expect(candidatos.map((c) => c["column_key"]).sort()).toEqual(["DONE", "TODO"]);
    expect(candidatos.every((c) => c["title"] === "Revisar HU-25")).toBe(true);

    // El hint es la parte que convierte el error en una instruccion: tiene que
    // decir que hacer, no solo que fallo. La herramienta NO elige por el usuario.
    expect(error(resultado)["hint"]).toContain("id exacto");
    expect(resultado.texto).toContain("Que hacer:");
  });

  it("un titulo inexistente devuelve NOT_FOUND con titulos proximos", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");
    await crear("QA", "TODO", "Revisar HU-26");
    await crear("QA", "DONE", "Desplegar a staging");

    const resultado = await llamar("move_task", {
      board: "QA",
      task: "Revisar HU-99",
      to_column: "DONE",
    });

    expect(error(resultado)["code"]).toBe("TASK_NOT_FOUND");

    const sugerencias = detalles(resultado)["suggestions"] as Array<Record<string, unknown>>;
    expect(sugerencias.length).toBeGreaterThan(0);
    expect(sugerencias.length).toBeLessThanOrEqual(5);
    // Proximos de verdad, no los tres primeros que aparecieron.
    expect(sugerencias.slice(0, 2).map((s) => s["title"]).sort()).toEqual([
      "Revisar HU-25",
      "Revisar HU-26",
    ]);
  });

  it("una coincidencia parcial unica procede", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");
    await crear("QA", "TODO", "Desplegar a staging");

    const resultado = await llamar("move_task", {
      board: "QA",
      task: "HU-25",
      to_column: "DONE",
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect((resultado.json["task"] as Record<string, unknown>)["title"]).toBe("Revisar HU-25");
  });

  it("el ambito es el tablero: una tarea de otro tablero no se encuentra", async () => {
    await sembrarTablero("QA");
    await sembrarTablero("Personal");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("move_task", {
      board: "Personal",
      task: "Revisar HU-25",
      to_column: "DONE",
    });

    // El tablero existe y la tarea existe; lo que no existe es esa tarea EN ese
    // tablero, y por eso la busqueda por titulo nunca es global.
    expect(error(resultado)["code"]).toBe("TASK_NOT_FOUND");
    expect(detalles(resultado)["board_name"]).toBe("Personal");
    expect(detalles(resultado)["suggestions"]).toEqual([]);
  });

  it("un nombre de tablero ambiguo no elige por el usuario", async () => {
    await sembrarTablero("QA");
    await sembrarTablero("QA");

    const resultado = await llamar("list_tasks", { board: "QA" });

    expect(error(resultado)["code"]).toBe("AMBIGUOUS_MATCH");
    expect((detalles(resultado)["candidates"] as unknown[]).length).toBe(2);
  });

  it("sin board, un titulo no se resuelve y se dice por que", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("move_task", { task: "Revisar HU-25", to_column: "DONE" });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(detalles(resultado)["field"]).toBe("board");
  });

  it("con el id de la tarea, board es innecesario", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const resultado = await llamar("move_task", { task: id, to_column: "En progreso" });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect((resultado.json["task"] as Record<string, unknown>)["column_key"]).toBe("IN_PROGRESS");
  });
});

// --- list_tasks --------------------------------------------------------------

describe("list_tasks", () => {
  it("agrupa por columna y devuelve las columnas del tablero", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");
    await crear("QA", "DONE", "Tres");

    const resultado = await llamar("list_tasks", { board: "QA" });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect(resultado.json["count"]).toBe(3);
    expect(resultado.json["has_more"]).toBe(false);

    const tareas = resultado.json["tasks"] as Array<Record<string, unknown>>;
    expect(tareas.map((t) => t["title"])).toEqual(["Uno", "Dos", "Tres"]);
    expect(tareas.map((t) => t["column_key"])).toEqual(["TODO", "TODO", "DONE"]);

    // Las columnas viajan siempre: con ellas el agente encadena un move sin
    // volver a consultar el tablero.
    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    expect(columnas.map((c) => c["key"])).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "DONE"]);

    expect(resultado.texto).toContain("TODO (2)");
    expect(resultado.texto).toContain("BACKLOG (0)");
  });

  it("filtra por columna y por prioridad", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Urgente", { priority: "URGENT" });
    await crear("QA", "TODO", "Normal");
    await crear("QA", "DONE", "Otra urgente", { priority: "URGENT" });

    const porColumna = await llamar("list_tasks", { board: "QA", column: "TODO" });
    expect((porColumna.json["tasks"] as unknown[]).length).toBe(2);

    const porPrioridad = await llamar("list_tasks", { board: "QA", priority: ["URGENT"] });
    const titulos = (porPrioridad.json["tasks"] as Array<Record<string, unknown>>).map(
      (t) => t["title"],
    );
    expect(titulos.sort()).toEqual(["Otra urgente", "Urgente"]);
  });

  it("un limite fuera de rango lo rechaza el protocolo, nombrando el campo", async () => {
    await sembrarTablero("QA");

    // El SDK valida contra el esquema ANTES de invocar el handler, asi que esto
    // ni siquiera llega al nucleo: vuelve como error -32602 del protocolo, que
    // el cliente entrega como resultado con isError. No trae el bloque JSON de
    // la 8.5 porque no lo genera una herramienta, pero si nombra el campo.
    const salida = await cliente.callTool({
      name: "list_tasks",
      arguments: { board: "QA", limit: 500 },
    });

    expect(salida.isError).toBe(true);
    expect((salida.content as Array<{ text?: string }>)[0]?.text).toContain("limit");
  });

  it("avisa cuando hay mas tareas de las que entran en limit", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");

    const resultado = await llamar("list_tasks", { board: "QA", limit: 1 });

    expect(resultado.json["has_more"]).toBe(true);
    expect(resultado.texto).toContain("Hay mas tareas");
  });
});

// --- Validacion propia del nucleo --------------------------------------------

describe("handler del nucleo", () => {
  it("valida su entrada sin depender de que el transporte lo haya hecho", async () => {
    // El SDK ya valida, pero la definicion es autocontenida a proposito: un
    // llamador directo (una prueba, un HttpPort) tiene que obtener el mismo
    // VALIDATION_ERROR con la lista de campos de la 6.4, no una excepcion.
    const listTasks = crearHerramientas(crearCorePort()).find(
      (herramienta) => herramienta.name === "list_tasks",
    );
    const salida = await listTasks?.handler({ board: "QA", limit: 500 });

    const bloque = salida?.content[0]?.text ?? "";
    const cuerpo = extraerJson(bloque)["error"] as Record<string, unknown>;
    expect(salida?.isError).toBe(true);
    expect(cuerpo["code"]).toBe("VALIDATION_ERROR");

    const campos = (cuerpo["details"] as Record<string, unknown>)["fields"] as Array<
      Record<string, unknown>
    >;
    expect(campos.some((campo) => campo["field"] === "limit")).toBe(true);
  });
});

// --- Orden ------------------------------------------------------------------

describe("orden", () => {
  it("create con position desplaza a las siguientes y move reordena la columna", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");
    const tercera = await crear("QA", "TODO", "Cero", { position: 0 });

    expect((tercera.json["task"] as Record<string, unknown>)["position"]).toBe(0);
    const orden = (tercera.json["column"] as Record<string, unknown>)["task_order"] as string[];
    expect(orden).toHaveLength(3);

    const movida = await llamar("move_task", {
      board: "QA",
      task: "Cero",
      to_column: "TODO",
      position: "end",
    });

    expect(movida.isError, movida.texto).toBe(false);
    expect(movida.texto).toContain("Tarea reordenada");
    const afectadas = movida.json["affected_columns"] as Array<Record<string, unknown>>;
    expect(afectadas).toHaveLength(1);
    expect((afectadas[0]?.["task_order"] as string[]).at(-1)).toBe(
      (movida.json["task"] as Record<string, unknown>)["id"],
    );
  });

  it("una posicion mayor que la columna se ajusta al final en vez de fallar", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");

    const resultado = await llamar("move_task", {
      board: "QA",
      task: "Uno",
      to_column: "DONE",
      position: 99,
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect((resultado.json["task"] as Record<string, unknown>)["position"]).toBe(0);
  });
});
