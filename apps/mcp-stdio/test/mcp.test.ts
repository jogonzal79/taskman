import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BoardRepository,
  BoardService,
  crearCorePort,
  crearHerramientas,
  SCOPES,
  TransactionRunner,
  type BoardDetail,
  type CamposDeLog,
  type Logger,
  type OpcionesRegistro,
  type PoliticaDestructiva,
} from "@taskman/core";
import { prisma } from "@taskman/db";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { crearServidorMcp } from "../src/server";
import { connectDb, ctx, truncateAll } from "./helpers";

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

/**
 * Un cliente conectado a un servidor propio. La configuracion se pasa por
 * parametro porque MCP_DESTRUCTIVE_POLICY cambia el CATALOGO, no solo el
 * comportamiento de una llamada: probarla exige levantar otro servidor, no
 * reconfigurar el que ya esta. Los scopes de la clave (8.1) lo cambian igual, y
 * por eso van siempre explicitos.
 */
async function conectar(opciones: OpcionesRegistro): Promise<McpClient> {
  const servidor = crearServidorMcp(crearCorePort(), opciones);
  const [transporteCliente, transporteServidor] = InMemoryTransport.createLinkedPair();
  const conectado = new McpClient({ name: "prueba", version: "0.0.0" });
  await Promise.all([servidor.connect(transporteServidor), conectado.connect(transporteCliente)]);
  return conectado;
}

beforeAll(async () => {
  db = await connectDb();
  tableros = new BoardService(new BoardRepository(new TransactionRunner(prisma)));
  // Los tres scopes: el catalogo entero. El filtrado tiene su propio bloque.
  cliente = await conectar({ scopes: SCOPES });
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

async function llamarCon(
  destino: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Resultado> {
  const salida = await destino.callTool({ name, arguments: args });
  const bloques = salida.content as Array<{ type: string; text?: string }>;

  expect(bloques).toHaveLength(1);
  const texto = bloques[0]?.text ?? "";

  return { texto, json: extraerJson(texto), isError: salida.isError === true };
}

async function llamar(name: string, args: Record<string, unknown>): Promise<Resultado> {
  return llamarCon(cliente, name, args);
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
  return tableros.create({ name }, ctx());
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
  it("anuncia las once herramientas de la 8.2", async () => {
    const { tools } = await cliente.listTools();

    // El catalogo completo: `cliente` se monta con los tres scopes, y delete_task
    // esta porque la politica por defecto es `confirm`. Con `deny` no se
    // anunciaria, y sin scope delete tampoco (ver los bloques de politica y de
    // scopes).
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_board",
      "create_column",
      "create_task",
      "delete_task",
      "get_board",
      "get_task",
      "list_boards",
      "list_tasks",
      "move_task",
      "search_tasks",
      "update_task",
    ]);
  });

  it("solo delete_task se anuncia como destructiva", async () => {
    const { tools } = await cliente.listTools();

    const destructivas = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name);

    // La 8.2 tiene una sola columna "Destructiva" en Si. Que el anuncio no
    // coincida con esa tabla es lo que haria que un cliente que confia en las
    // anotaciones pida confirmacion donde no hace falta, o peor, no la pida.
    expect(destructivas).toEqual(["delete_task"]);
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

  it("los once esquemas declaran additionalProperties: false, para que el cliente sepa que un argumento de mas se rechaza", async () => {
    const { tools } = await cliente.listTools();

    expect(tools).toHaveLength(11);
    for (const tool of tools) {
      expect(tool.inputSchema["additionalProperties"], tool.name).toBe(false);
    }
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

    expect(campos("list_boards")).toEqual(["limit"]);
    expect(campos("get_board")).toEqual(["board"]);
    expect(campos("create_board")).toEqual(["columns", "description", "name"]);
    expect(campos("create_column")).toEqual(["board", "key", "name", "position"]);
    expect(campos("get_task")).toEqual(["board", "task"]);
    expect(campos("delete_task")).toEqual(["board", "confirm", "task"]);
    expect(campos("search_tasks")).toEqual(["board", "column", "limit", "text"]);
    // `position` y `column` estan declarados a proposito aunque update_task no
    // los aplique: sin declararlos el validador los descartaria en silencio y
    // la herramienta contestaria "actualizada" sin haber movido nada.
    expect(campos("update_task")).toEqual([
      "board",
      "column",
      "description",
      "due_date",
      "position",
      "priority",
      "task",
      "title",
    ]);

    const obligatorios = (nombre: string): string[] =>
      [
        ...((tools.find((candidata) => candidata.name === nombre)?.inputSchema.required ??
          []) as string[]),
      ].sort();

    // `task` y `to_column` son obligatorios; `board` no, porque un id de tarea
    // ya trae su tablero.
    expect(obligatorios("move_task")).toEqual(["task", "to_column"]);
    // Un tablero se crea solo con su nombre: las columnas son opcionales y sin
    // ellas se crean las cuatro de la 4.3.
    expect(obligatorios("create_board")).toEqual(["name"]);
    expect(obligatorios("create_column")).toEqual(["board", "key", "name"]);
    expect(obligatorios("get_task")).toEqual(["task"]);
    expect(obligatorios("update_task")).toEqual(["task"]);
    // `confirm` NO es obligatorio: omitirlo es justamente la primera mitad del
    // dialogo de la 8.3.2. Declararlo requerido convertiria una confirmacion
    // pendiente en un error de esquema, y el agente no veria que iba a borrar.
    expect(obligatorios("delete_task")).toEqual(["task"]);
    expect(obligatorios("search_tasks")).toEqual(["text"]);
    // Listar tableros no necesita ningun argumento: es como se descubre que hay.
    expect(obligatorios("list_boards")).toEqual([]);
  });
});

// --- Tableros y columnas -----------------------------------------------------

describe("create_board", () => {
  it("sin columnas crea las cuatro por defecto de la 4.3", async () => {
    const resultado = await llamar("create_board", { name: "QA" });

    expect(resultado.isError, resultado.texto).toBe(false);
    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    // Keys, nombres y orden exactos: son el contrato con el que los agentes
    // resuelven referencias, asi que un cambio aca rompe integraciones.
    expect(columnas.map((c) => c["key"])).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "DONE"]);
    expect(columnas.map((c) => c["name"])).toEqual([
      "Backlog",
      "Por hacer",
      "En progreso",
      "Completado",
    ]);
    expect(columnas.map((c) => c["position"])).toEqual([0, 1, 2, 3]);

    const tablero = resultado.json["board"] as Record<string, unknown>;
    expect(tablero["name"]).toBe("QA");
    expect(resultado.texto).toContain('"QA"');
  });

  it("el tablero queda listo para recibir tareas en la llamada siguiente", async () => {
    // Es el hueco que motivo la herramienta: sin ella un flujo que arranca con
    // un tablero nuevo obliga a salir a crearlo por otra via.
    await llamar("create_board", { name: "QA", description: "Tablero del equipo" });

    const creada = await crear("QA", "TODO", "Revisar HU-25");

    expect((creada.json["task"] as Record<string, unknown>)["column_key"]).toBe("TODO");
  });

  it("con columnas explicitas usa esas, en ese orden y con la key normalizada", async () => {
    const resultado = await llamar("create_board", {
      name: "Personal",
      columns: [
        { key: "ideas", name: "Ideas" },
        { key: "en revision", name: "En revision" },
      ],
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    expect(columnas.map((c) => c["key"])).toEqual(["IDEAS", "EN_REVISION"]);
    expect(columnas.map((c) => c["position"])).toEqual([0, 1]);
  });

  it("un nombre vacio devuelve el error de dominio, no una excepcion", async () => {
    const resultado = await llamar("create_board", { name: "   " });

    expect(error(resultado)["code"]).toBe("NAME_REQUIRED");
  });
});

describe("create_column", () => {
  it("agrega la columna al final y devuelve el orden final del tablero", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_column", {
      board: "QA",
      key: "en revision",
      name: "En revision",
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    const columna = resultado.json["column"] as Record<string, unknown>;
    expect(columna["key"]).toBe("EN_REVISION");
    expect(columna["position"]).toBe(4);

    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    expect(columnas.map((c) => c["key"])).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
      "EN_REVISION",
    ]);
  });

  it("con position concreta desplaza a las siguientes", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_column", {
      board: "QA",
      key: "TRIAGE",
      name: "Triage",
      position: 0,
    });

    expect((resultado.json["column"] as Record<string, unknown>)["position"]).toBe(0);
    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    expect(columnas.map((c) => c["key"])).toEqual([
      "TRIAGE",
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "DONE",
    ]);
    expect(columnas.map((c) => c["position"])).toEqual([0, 1, 2, 3, 4]);
  });

  it("la columna nueva recibe tareas como cualquier otra", async () => {
    await sembrarTablero("QA");
    await llamar("create_column", { board: "QA", key: "EN_REVISION", name: "En revision" });

    const creada = await crear("QA", "En revision", "Revisar HU-25");

    expect((creada.json["task"] as Record<string, unknown>)["column_key"]).toBe("EN_REVISION");
  });

  it("una key repetida devuelve DUPLICATE_KEY con que hacer", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("create_column", { board: "QA", key: "todo", name: "Otra" });

    expect(error(resultado)["code"]).toBe("DUPLICATE_KEY");
    expect(error(resultado)["hint"]).toContain("otra key");
  });
});

describe("list_boards", () => {
  it("lista los tableros con su id y su nombre", async () => {
    await sembrarTablero("QA");
    await sembrarTablero("Personal");

    const resultado = await llamar("list_boards", {});

    expect(resultado.isError, resultado.texto).toBe(false);
    const tableros = resultado.json["boards"] as Array<Record<string, unknown>>;
    expect(tableros.map((t) => t["name"]).sort()).toEqual(["Personal", "QA"]);
    expect(tableros.every((t) => typeof t["id"] === "string")).toBe(true);
    expect(resultado.json["count"]).toBe(2);
    expect(resultado.json["has_more"]).toBe(false);
  });

  it("sin tableros no falla: es como el agente descubre que no hay ninguno", async () => {
    const resultado = await llamar("list_boards", {});

    expect(resultado.isError, resultado.texto).toBe(false);
    expect(resultado.json["boards"]).toEqual([]);
  });
});

describe("get_board", () => {
  it("devuelve las columnas en orden y cuantas tareas tiene cada una", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");
    await crear("QA", "DONE", "Tres");

    const resultado = await llamar("get_board", { board: "QA" });

    expect(resultado.isError, resultado.texto).toBe(false);
    const columnas = resultado.json["columns"] as Array<Record<string, unknown>>;
    expect(columnas.map((c) => c["key"])).toEqual(["BACKLOG", "TODO", "IN_PROGRESS", "DONE"]);
    expect(columnas.map((c) => c["task_count"])).toEqual([0, 2, 0, 1]);
    expect(resultado.json["task_count"]).toBe(3);
    expect(resultado.texto).toContain("TODO");
  });

  it("trae lo que hace falta para encadenar sin volver a resolver nada", async () => {
    await sembrarTablero("QA");

    const tablero = await llamar("get_board", { board: "QA" });
    const board = tablero.json["board"] as Record<string, unknown>;
    const columnas = tablero.json["columns"] as Array<Record<string, unknown>>;
    const todo = columnas.find((columna) => columna["key"] === "TODO");

    // La llamada siguiente va con los ids que devolvio get_board, sin nombres.
    const creada = await crear(board["id"] as string, todo?.["id"] as string, "Revisar HU-25");

    const tarea = creada.json["task"] as Record<string, unknown>;
    expect(tarea["column_id"]).toBe(todo?.["id"]);
    expect(tarea["board_id"]).toBe(board["id"]);
  });

  it("un tablero inexistente devuelve BOARD_NOT_FOUND", async () => {
    await sembrarTablero("QA");

    const resultado = await llamar("get_board", { board: "Inexistente" });

    expect(error(resultado)["code"]).toBe("BOARD_NOT_FOUND");
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

  it("EL CASO QUE MOTIVO EL CAMBIO: status: 'DONE' no devuelve el tablero entero, devuelve un error que nombra status", async () => {
    // `status` es el nombre que tiene el filtro en casi cualquier otro gestor;
    // aca es `column`. Antes el argumento se descartaba en silencio y la
    // herramienta contestaba las dos tareas como si hubiera acotado.
    await sembrarTablero("QA");
    await crear("QA", "TODO", "pendiente");
    await crear("QA", "DONE", "hecha");

    const salida = await cliente.callTool({
      name: "list_tasks",
      arguments: { board: "QA", status: "DONE" },
    });

    expect(salida.isError).toBe(true);
    const texto = (salida.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(texto).toContain('"status"');
    expect(texto).not.toContain("pendiente");
    expect(texto).not.toContain("hecha");
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
    const listTasks = crearHerramientas(crearCorePort(), { scopes: SCOPES }).find(
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

  it("un argumento que no declara es VALIDATION_ERROR con la clave NOMBRADA, como en el borde REST", async () => {
    // Invocado directo, el handler es lo unico que valida, y es la respuesta de
    // la 8.5 la que tiene que nombrar el sobrante: en el mensaje para quien lee
    // y como campo de `details.fields` para quien actua sobre el.
    const listTasks = crearHerramientas(crearCorePort(), { scopes: SCOPES }).find(
      (herramienta) => herramienta.name === "list_tasks",
    );
    const salida = await listTasks?.handler({ board: "QA", status: "DONE" });

    const cuerpo = extraerJson(salida?.content[0]?.text ?? "")["error"] as Record<string, unknown>;
    expect(salida?.isError).toBe(true);
    expect(cuerpo["code"]).toBe("VALIDATION_ERROR");
    expect(cuerpo["message"]).toContain("'status'");

    const campos = (cuerpo["details"] as Record<string, unknown>)["fields"] as Array<
      Record<string, unknown>
    >;
    expect(campos).toEqual([{ field: "status", reason: expect.any(String) }]);
  });
});

// --- Argumentos que la herramienta no declara ---------------------------------

/**
 * UNA LLAMADA MINIMA VALIDA POR HERRAMIENTA, sobre un tablero "QA" con las
 * cuatro columnas de la 4.3 y una tarea "Tarea" en TODO. Es una TABLA y no una
 * muestra a proposito: la forma del esquema se decide en un solo lugar
 * (`esquemaDeEntrada`), pero lo que se afirma es que las once lo usan, y una
 * herramienta que se registrara con otro esquema fallaria aca por su nombre.
 *
 * El orden importa para la segunda pasada, la que ejecuta cada llamada SIN el
 * argumento de mas: `delete_task` va ultima porque se lleva la tarea.
 */
const LLAMADA_MINIMA: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["list_boards", {}],
  ["get_board", { board: "QA" }],
  ["create_board", { name: "Nuevo" }],
  ["create_column", { board: "QA", key: "REVIEW", name: "En revision" }],
  ["list_tasks", { board: "QA" }],
  ["search_tasks", { text: "Tarea" }],
  ["get_task", { board: "QA", task: "Tarea" }],
  ["create_task", { board: "QA", column: "TODO", title: "Otra" }],
  ["update_task", { board: "QA", task: "Tarea", priority: "HIGH" }],
  ["move_task", { board: "QA", task: "Tarea", to_column: "DONE" }],
  ["delete_task", { board: "QA", task: "Tarea", confirm: true }],
];

describe("argumentos que la herramienta no declara", () => {
  it("la tabla cubre las once de la 8.2, ni una menos", async () => {
    const { tools } = await cliente.listTools();

    expect(LLAMADA_MINIMA.map(([nombre]) => nombre).sort()).toEqual(
      tools.map((tool) => tool.name).sort(),
    );
  });

  it("en las ONCE, un argumento de mas se rechaza nombrandolo, y sin el la misma llamada ejecuta", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Tarea");
    const auditadoAntes = await prisma.auditLog.count();

    // Primera pasada: las once con un argumento inventado. Ninguna ejecuta.
    for (const [nombre, argumentos] of LLAMADA_MINIMA) {
      const salida = await cliente.callTool({
        name: nombre,
        arguments: { ...argumentos, argumento_inventado: "x" },
      });

      expect(salida.isError, `${nombre} acepto un argumento que no declara`).toBe(true);
      // Lo rechaza el protocolo antes del handler, asi que no trae el bloque
      // JSON de la 8.5 —igual que un `limit` fuera de rango— pero SI nombra la
      // clave: es lo que el agente necesita para corregir la llamada.
      const texto = (salida.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(texto, nombre).toContain('"argumento_inventado"');
    }

    // Nada se escribio ni se borro: la unica tarea sigue, no hay tablero
    // "Nuevo", y la auditoria no crecio.
    expect(await prisma.task.count()).toBe(1);
    expect(await prisma.board.count()).toBe(1);
    expect(await prisma.auditLog.count()).toBe(auditadoAntes);

    // Segunda pasada: las mismas once sin el argumento de mas. Todas ejecutan,
    // lo que prueba que lo rechazado era la clave y no el resto de la llamada.
    for (const [nombre, argumentos] of LLAMADA_MINIMA) {
      const resultado = await llamar(nombre, argumentos);
      expect(resultado.isError, `${nombre}: ${resultado.texto}`).toBe(false);
    }
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

// --- get_task ----------------------------------------------------------------

describe("get_task", () => {
  it("devuelve la tarea completa con su ubicacion", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25", {
      description: "Repasar los criterios de aceptacion",
      priority: "HIGH",
      due_date: "2026-09-11",
    });

    const resultado = await llamar("get_task", { board: "QA", task: "revisar hu-25" });

    expect(resultado.isError, resultado.texto).toBe(false);
    const tarea = resultado.json["task"] as Record<string, unknown>;
    expect(tarea["title"]).toBe("Revisar HU-25");
    expect(tarea["description"]).toBe("Repasar los criterios de aceptacion");
    expect(tarea["priority"]).toBe("HIGH");
    expect(tarea["due_date"]).toBe("2026-09-11");
    expect(tarea["column_key"]).toBe("TODO");
    expect(tarea["position"]).toBe(0);

    expect((resultado.json["board"] as Record<string, unknown>)["name"]).toBe("QA");
    expect((resultado.json["column"] as Record<string, unknown>)["key"]).toBe("TODO");

    // La descripcion entera va tambien en el texto: es lo que list_tasks
    // resume y por lo que un agente llama a esta herramienta.
    expect(resultado.texto).toContain("Repasar los criterios de aceptacion");
  });

  it("con el id de la tarea, board es innecesario", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "DONE", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const resultado = await llamar("get_task", { task: id });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect((resultado.json["task"] as Record<string, unknown>)["column_key"]).toBe("DONE");
  });

  it("sin board, un titulo no se resuelve y se dice por que", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("get_task", { task: "Revisar HU-25" });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(detalles(resultado)["field"]).toBe("board");
  });
});

// --- update_task -------------------------------------------------------------

describe("update_task", () => {
  it("aplica un patch parcial y deja el resto como estaba", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25", {
      priority: "LOW",
      description: "Original",
      due_date: "2026-09-11",
    });

    const resultado = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-25",
      priority: "URGENT",
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    const tarea = resultado.json["task"] as Record<string, unknown>;
    expect(tarea["priority"]).toBe("URGENT");
    expect(tarea["title"]).toBe("Revisar HU-25");
    expect(tarea["description"]).toBe("Original");
    expect(tarea["due_date"]).toBe("2026-09-11");
    // Ni la columna ni la posicion se tocan: update_task no las cambia.
    expect(tarea["column_key"]).toBe("TODO");
    expect(tarea["position"]).toBe(0);
  });

  it("null borra la descripcion y el vencimiento; omitirlos los deja", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25", {
      description: "Original",
      due_date: "2026-09-11",
    });

    const resultado = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-25",
      description: null,
      title: "Revisar HU-26",
    });

    const tarea = resultado.json["task"] as Record<string, unknown>;
    expect(tarea["description"]).toBeNull();
    expect(tarea["title"]).toBe("Revisar HU-26");
    expect(tarea["due_date"]).toBe("2026-09-11");

    const sinFecha = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-26",
      due_date: null,
    });
    expect((sinFecha.json["task"] as Record<string, unknown>)["due_date"]).toBeNull();
  });

  it("rechaza position y le dice al agente que use move_task", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-25",
      position: 0,
    });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    const campos = detalles(resultado)["fields"] as Array<Record<string, unknown>>;
    expect(campos.map((campo) => campo["field"])).toEqual(["position"]);
    // El hint es exactamente para esto: decir con que herramienta se hace.
    expect(error(resultado)["hint"]).toContain("move_task");
    expect(resultado.texto).toContain("move_task");

    // Y no movio nada: aceptarlo en silencio seria lo peligroso.
    const despues = await llamar("get_task", { board: "QA", task: "Revisar HU-25" });
    expect((despues.json["task"] as Record<string, unknown>)["position"]).toBe(1);
  });

  it("rechaza column y le dice al agente que use move_task", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-25",
      column: "DONE",
    });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    const campos = detalles(resultado)["fields"] as Array<Record<string, unknown>>;
    expect(campos.map((campo) => campo["field"])).toEqual(["column"]);
    expect(error(resultado)["hint"]).toContain("move_task");

    const despues = await llamar("get_task", { board: "QA", task: "Revisar HU-25" });
    expect((despues.json["task"] as Record<string, unknown>)["column_key"]).toBe("TODO");
  });

  it("sin ningun campo modificable lo dice en vez de responder que actualizo", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("update_task", { board: "QA", task: "Revisar HU-25" });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(error(resultado)["hint"]).toContain("title");
  });

  it("un titulo vacio devuelve el error de dominio", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("update_task", {
      board: "QA",
      task: "Revisar HU-25",
      title: "   ",
    });

    expect(error(resultado)["code"]).toBe("TITLE_REQUIRED");
  });
});

// --- search_tasks ------------------------------------------------------------

describe("search_tasks", () => {
  it("encuentra por titulo y por descripcion", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar el contrato");
    await crear("QA", "DONE", "Pendiente", { description: "Falta firmar el contrato" });
    await crear("QA", "TODO", "Nada que ver");

    const resultado = await llamar("search_tasks", { board: "QA", text: "contrato" });

    expect(resultado.isError, resultado.texto).toBe(false);
    const tareas = resultado.json["tasks"] as Array<Record<string, unknown>>;
    expect(tareas.map((t) => t["title"]).sort()).toEqual(["Pendiente", "Revisar el contrato"]);
    expect(resultado.json["count"]).toBe(2);
    expect(resultado.json["has_more"]).toBe(false);
  });

  it("sin board busca en todos los tableros y dice en cual esta cada tarea", async () => {
    await sembrarTablero("QA");
    await sembrarTablero("Personal");
    await crear("QA", "TODO", "Informe mensual");
    await crear("Personal", "DONE", "Informe anual");

    const resultado = await llamar("search_tasks", { text: "informe" });

    const tareas = resultado.json["tasks"] as Array<Record<string, unknown>>;
    // Sin el tablero y la columna de cada coincidencia, una busqueda global
    // devuelve titulos que el agente no puede ubicar ni encadenar.
    expect(tareas.map((t) => t["board_name"]).sort()).toEqual(["Personal", "QA"]);
    expect(tareas.map((t) => t["column_key"]).sort()).toEqual(["DONE", "TODO"]);
  });

  it("acota por columna dentro del tablero", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Informe mensual");
    await crear("QA", "DONE", "Informe anual");

    const resultado = await llamar("search_tasks", {
      board: "QA",
      column: "DONE",
      text: "informe",
    });

    const tareas = resultado.json["tasks"] as Array<Record<string, unknown>>;
    expect(tareas.map((t) => t["title"])).toEqual(["Informe anual"]);
  });

  it("una columna sin board no se resuelve y se dice por que", async () => {
    await sembrarTablero("QA");
    await crear("QA", "DONE", "Informe anual");

    const resultado = await llamar("search_tasks", { text: "informe", column: "DONE" });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(detalles(resultado)["field"]).toBe("board");
  });

  it("sin coincidencias devuelve una pagina vacia y dice que hacer", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("search_tasks", { board: "QA", text: "inexistente" });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect(resultado.json["tasks"]).toEqual([]);
    expect(resultado.texto).toContain("Ninguna coincidencia");
  });
});

// --- delete_task -------------------------------------------------------------

describe("delete_task", () => {
  it("sin confirm no borra y devuelve el detalle completo de lo que desapareceria", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25", {
      priority: "HIGH",
      due_date: "2026-09-11",
      description: "Falta el criterio de aceptacion 3.",
    });

    const resultado = await llamar("delete_task", { board: "QA", task: "Revisar HU-25" });

    expect(error(resultado)["code"]).toBe("CONFIRMATION_REQUIRED");

    // El agente tiene que poder mostrarle al usuario que va a desaparecer, y
    // eso se lee del TEXTO: un detalle que solo esta en el JSON obliga al
    // modelo a parafrasear una estructura en vez de citar una tarea.
    expect(resultado.texto).toContain("Revisar HU-25");
    expect(resultado.texto).toContain("TODO");
    expect(resultado.texto).toContain("HIGH");
    expect(resultado.texto).toContain("2026-09-11");
    expect(resultado.texto).toContain("Falta el criterio de aceptacion 3.");

    const tarea = detalles(resultado)["task"] as Record<string, unknown>;
    expect(tarea["title"]).toBe("Revisar HU-25");
    expect(tarea["column_key"]).toBe("TODO");
    expect(tarea["priority"]).toBe("HIGH");
    expect(tarea["due_date"]).toBe("2026-09-11");
    expect(tarea["description"]).toBe("Falta el criterio de aceptacion 3.");

    // Y la tarea sigue existiendo: una confirmacion que ya borro no confirma nada.
    const despues = await llamar("get_task", { board: "QA", task: "Revisar HU-25" });
    expect(despues.isError, despues.texto).toBe(false);
  });

  it("el hint trae el id resuelto, no el titulo con el que se llamo", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const resultado = await llamar("delete_task", { board: "QA", task: "Revisar HU-25" });

    // La segunda llamada tiene que apuntar a ESTA tarea. Si el hint repitiera
    // el titulo, entre la confirmacion y el borrado podria aparecer otra tarea
    // homonima, y el "si, borrala" del usuario caeria sobre un conjunto
    // distinto del que se le mostro.
    expect(error(resultado)["hint"]).toContain(id);
  });

  it("con confirm borra y la columna queda densa", async () => {
    await sembrarTablero("QA");
    const primera = await crear("QA", "TODO", "Uno");
    await crear("QA", "TODO", "Dos");
    const tercera = await crear("QA", "TODO", "Tres");

    const resultado = await llamar("delete_task", { board: "QA", task: "Dos", confirm: true });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect(resultado.texto).toContain("Tarea eliminada");

    const columna = resultado.json["column"] as Record<string, unknown>;
    expect(columna["key"]).toBe("TODO");
    // El orden final completo, para encadenar sin volver a listar (8.5).
    expect(columna["task_order"]).toEqual([
      (primera.json["task"] as Record<string, unknown>)["id"],
      (tercera.json["task"] as Record<string, unknown>)["id"],
    ]);

    const quedan = await llamar("list_tasks", { board: "QA", column: "TODO" });
    const tareas = quedan.json["tasks"] as Array<Record<string, unknown>>;
    expect(tareas.map((tarea) => tarea["title"])).toEqual(["Uno", "Tres"]);
    // 0..n-1 sin huecos: el borrado reescribe la secuencia entera.
    expect(tareas.map((tarea) => tarea["position"])).toEqual([0, 1]);
  });

  it("un titulo ambiguo devuelve AMBIGUOUS_MATCH antes de pedir confirmacion", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");
    await crear("QA", "DONE", "Revisar HU-25");

    const resultado = await llamar("delete_task", { board: "QA", task: "Revisar HU-25" });

    // Nunca se pide confirmar una tarea que no esta identificada de forma
    // unica: confirmar "Revisar HU-25" cuando hay dos es confirmar cual de las
    // dos, y la herramienta no elige.
    expect(error(resultado)["code"]).toBe("AMBIGUOUS_MATCH");
    const candidatos = detalles(resultado)["candidates"] as Array<Record<string, unknown>>;
    expect(candidatos).toHaveLength(2);
    expect(candidatos.map((candidato) => candidato["column_key"]).sort()).toEqual(["DONE", "TODO"]);

    // Y con confirm: true tampoco borra ninguna.
    const forzado = await llamar("delete_task", {
      board: "QA",
      task: "Revisar HU-25",
      confirm: true,
    });
    expect(error(forzado)["code"]).toBe("AMBIGUOUS_MATCH");

    const quedan = await llamar("list_tasks", { board: "QA" });
    expect((quedan.json["tasks"] as unknown[]).length).toBe(2);
  });

  it("un titulo sin board no se resuelve y se dice por que", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamar("delete_task", { task: "Revisar HU-25", confirm: true });

    expect(error(resultado)["code"]).toBe("VALIDATION_ERROR");
    expect(detalles(resultado)["field"]).toBe("board");
  });

  it("borrar dos veces la misma tarea falla la segunda", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    expect((await llamar("delete_task", { task: id, confirm: true })).isError).toBe(false);

    // Por esto la herramienta no se anuncia idempotente: repetirla no deja el
    // mismo resultado observable.
    const segunda = await llamar("delete_task", { task: id, confirm: true });
    expect(error(segunda)["code"]).toBe("TASK_NOT_FOUND");
  });
});

// --- MCP_DESTRUCTIVE_POLICY (8.3.2) ------------------------------------------

describe("MCP_DESTRUCTIVE_POLICY", () => {
  const clientes = new Map<PoliticaDestructiva, McpClient>();

  /** Un cliente por politica, reusado: cada uno levanta su propio servidor. */
  async function con(politicaDestructiva: PoliticaDestructiva): Promise<McpClient> {
    const existente = clientes.get(politicaDestructiva);
    if (existente !== undefined) {
      return existente;
    }
    const nuevo = await conectar({ scopes: SCOPES, politicaDestructiva });
    clientes.set(politicaDestructiva, nuevo);
    return nuevo;
  }

  afterAll(async () => {
    await Promise.all([...clientes.values()].map(async (abierto) => abierto.close()));
  });

  it("allow borra sin confirm", async () => {
    await sembrarTablero("QA");
    await crear("QA", "TODO", "Revisar HU-25");

    const resultado = await llamarCon(await con("allow"), "delete_task", {
      board: "QA",
      task: "Revisar HU-25",
    });

    expect(resultado.isError, resultado.texto).toBe(false);
    expect(resultado.texto).toContain("Tarea eliminada");

    const quedan = await llamar("list_tasks", { board: "QA" });
    expect(quedan.json["tasks"]).toEqual([]);
  });

  it("allow lo dice en la descripcion en vez de dejar que el agente lo descubra borrando", async () => {
    const { tools } = await (await con("allow")).listTools();
    const deleteTask = tools.find((tool) => tool.name === "delete_task");

    expect(deleteTask?.description ?? "").toContain("allow");
    expect(deleteTask?.description ?? "").toContain("de inmediato");
  });

  it("deny no anuncia la herramienta", async () => {
    const { tools } = await (await con("deny")).listTools();

    // El filtrado va en el LISTADO y no solo en la ejecucion (8.1): si el
    // agente la ve, planifica un borrado que despues no puede completar.
    expect(tools.map((tool) => tool.name)).not.toContain("delete_task");
    // Y no se lleva puesto el resto del catalogo.
    expect(tools).toHaveLength(10);
  });

  it("deny falla si se la invoca igual, y no borra", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const denegado = await con("deny");

    // Un cliente puede llamar una herramienta que no figura en el listado. La
    // rechaza el SDK, por deshabilitada, antes de llegar al handler del nucleo:
    // el precio de que el filtrado tambien valga en la ejecucion es que el
    // mensaje lo redacta el SDK y no nosotros. Llega igual como resultado de
    // herramienta y no como excepcion, asi que el agente lo lee.
    const salida = await denegado.callTool({
      name: "delete_task",
      arguments: { task: id, confirm: true },
    });
    const bloques = salida.content as Array<{ type: string; text?: string }>;

    expect(salida.isError).toBe(true);
    // "disabled", no "not found": no niega que la herramienta exista, que es la
    // razon por la que la definicion se registra en vez de omitirse.
    expect(bloques[0]?.text ?? "").toContain("delete_task");
    expect(bloques[0]?.text ?? "").toContain("disabled");

    // Y lo que de verdad importa: no borro nada.
    const despues = await llamar("get_task", { task: id });
    expect(despues.isError, despues.texto).toBe(false);
  });

  it("deny explica por que en el handler, que es lo que ve cualquier otro llamador", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const deleteTask = crearHerramientas(crearCorePort(), {
      scopes: SCOPES,
      politicaDestructiva: "deny",
    }).find((herramienta) => herramienta.name === "delete_task");

    // Sigue estando en el registro: omitirla daria "herramienta desconocida",
    // que no distingue una politica de un error.
    expect(deleteTask?.anunciada).toBe(false);

    const salida = await deleteTask?.handler({ task: id, confirm: true });
    const cuerpo = extraerJson(salida?.content[0]?.text ?? "")["error"] as Record<string, unknown>;

    expect(salida?.isError).toBe(true);
    expect(cuerpo["code"]).toBe("DESTRUCTIVE_POLICY_DENIED");
    expect(cuerpo["message"]).toContain("MCP_DESTRUCTIVE_POLICY");
    // El hint tiene que cerrar la puerta, no sugerir un reintento: un agente
    // que lea "volve a intentar con confirm" va a insistir para siempre.
    expect(cuerpo["hint"]).toContain("sigue existiendo");

    const despues = await llamar("get_task", { task: id });
    expect(despues.isError, despues.texto).toBe(false);
  });

  it("un valor invalido impide el arranque del proceso (11.2)", async () => {
    const entrada = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    expect(
      existsSync(entrada),
      `No existe ${entrada}. Corre pnpm run build antes de la suite.`,
    ).toBe(true);

    const salida = await new Promise<{ code: number | null; stderr: string }>((resolver) => {
      const hijo = spawn(process.execPath, [entrada], {
        env: { ...process.env, MCP_PORT_MODE: "core", MCP_DESTRUCTIVE_POLICY: "denyy" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      hijo.stderr.on("data", (trozo: Buffer) => {
        stderr += trozo.toString();
      });
      hijo.on("close", (code) => resolver({ code, stderr }));
    });

    // La 11.2 es explicita. Arrancar con el valor por defecto seria peor que no
    // arrancar: quien escribio "denyy" cree tener el borrado apagado.
    expect(salida.code).toBe(1);
    expect(salida.stderr).toContain("MCP_DESTRUCTIVE_POLICY");
    expect(salida.stderr).toContain("confirm, allow, deny");
  });
});

// --- Scopes de la clave (8.1 y 7.2) ------------------------------------------

/**
 * El catalogo que ve un cliente segun los scopes de su clave, por el protocolo.
 *
 * Que `crearHerramientas` devuelva la lista correcta para cada combinacion lo
 * prueba `packages/core/test/mcp-scope.test.ts` contra la tabla transcripta de la
 * 8.2. Lo que se prueba aca es lo que la 8.1 pide de verdad: que el agente no la
 * VEA al listar, y que invocarla igual no ejecute nada.
 */
describe("scopes de la clave", () => {
  const ONCE = [
    "create_board",
    "create_column",
    "create_task",
    "delete_task",
    "get_board",
    "get_task",
    "list_boards",
    "list_tasks",
    "move_task",
    "search_tasks",
    "update_task",
  ];
  const DIEZ_SIN_DELETE = ONCE.filter((nombre) => nombre !== "delete_task");
  const SIN_DELETE = ["READ", "WRITE"] as const;

  const abiertos: McpClient[] = [];

  /** Un servidor por combinacion: los scopes entran al montar, como la politica. */
  async function con(opciones: OpcionesRegistro): Promise<McpClient> {
    const nuevo = await conectar(opciones);
    abiertos.push(nuevo);
    return nuevo;
  }

  afterAll(async () => {
    await Promise.all(abiertos.map(async (abierto) => abierto.close()));
  });

  async function listadas(destino: McpClient): Promise<string[]> {
    const { tools } = await destino.listTools();
    return tools.map((tool) => tool.name).sort();
  }

  /** El texto con el que el SDK rechaza invocar delete_task. No trae el JSON de la 8.5. */
  async function rechazoDeDelete(destino: McpClient, task: string): Promise<string> {
    const salida = await destino.callTool({ name: "delete_task", arguments: { task, confirm: true } });
    expect(salida.isError).toBe(true);
    return (salida.content as Array<{ text?: string }>)[0]?.text ?? "";
  }

  it("con los tres scopes se listan las once", async () => {
    expect(await listadas(await con({ scopes: SCOPES }))).toEqual(ONCE);
  });

  it("sin scope delete, delete_task no se lista y el resto si", async () => {
    // El DEBE de la 8.1: un cliente sin scope delete no ve disponible
    // delete_task, porque un agente que la ve la incluye en su plan.
    expect(await listadas(await con({ scopes: SIN_DELETE }))).toEqual(DIEZ_SIN_DELETE);
  });

  it("con solo read se listan las cinco de lectura de la 8.2 y ninguna que escriba", async () => {
    const { tools } = await (await con({ scopes: ["READ"] })).listTools();

    // Las cinco filas de la 8.2 con Scope read.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_board",
      "get_task",
      "list_boards",
      "list_tasks",
      "search_tasks",
    ]);
    // Y lo mismo desde el lado del agente, que no lee la 8.2 sino las anotaciones.
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("tres scopes y deny: quedan diez, y delete_task esta apagada por la politica", async () => {
    const denegado = await con({ scopes: SCOPES, politicaDestructiva: "deny" });

    expect(await listadas(denegado)).toEqual(DIEZ_SIN_DELETE);
    // El motivo se ve al invocarla: la politica la registra y la apaga, asi que
    // el SDK dice "disabled". Tener el scope no la vuelve a prender.
    expect(await rechazoDeDelete(denegado, "Revisar HU-25")).toContain("disabled");
  });

  it("sin delete y con confirm: quedan diez, pero porque delete_task no existe", async () => {
    await sembrarTablero("QA");
    const creada = await crear("QA", "TODO", "Revisar HU-25");
    const id = (creada.json["task"] as Record<string, unknown>)["id"] as string;

    const sinDelete = await con({ scopes: SIN_DELETE, politicaDestructiva: "confirm" });
    expect(await listadas(sinDelete)).toEqual(DIEZ_SIN_DELETE);

    // Invocarla igual es posible —el protocolo no obliga a listar antes— y el SDK
    // la rechaza antes de cualquier handler como desconocida, porque no se
    // registro. El texto es del SDK: nombra la herramienta pero no el scope que
    // falta, y es el mismo que recibiria un nombre mal escrito.
    const texto = await rechazoDeDelete(sinDelete, id);
    expect(texto).toContain("delete_task");
    expect(texto).toContain("not found");

    // Lo que importa: no borro nada.
    const despues = await llamar("get_task", { task: id });
    expect(despues.isError, despues.texto).toBe(false);
  });

  it("sin delete y con deny: la politica no la vuelve a montar", async () => {
    const ambos = await con({ scopes: SIN_DELETE, politicaDestructiva: "deny" });

    expect(await listadas(ambos)).toEqual(DIEZ_SIN_DELETE);
    // "not found" y no "disabled": lo que no se registro no se puede apagar, asi
    // que con los dos filtros a la vez se ve el de scopes.
    expect(await rechazoDeDelete(ambos, "Revisar HU-25")).toContain("not found");
  });

  it("solo delete y deny: el listado queda vacio, pero el servidor se monta", async () => {
    // El borde de los dos filtros juntos. La clave tiene el scope, asi que
    // delete_task se registra; la politica la apaga, y no queda nada que listar.
    // El SDK lo sirve como lista vacia. Lo que NO se monta es un servidor al que
    // los scopes no le dejan ninguna herramienta (ver `crearHerramientas`).
    const soloDelete = await con({ scopes: ["DELETE"], politicaDestructiva: "deny" });

    expect(await listadas(soloDelete)).toEqual([]);
  });
});

// --- Auditoria (7.4) ---------------------------------------------------------

interface FilaAuditoria {
  actor_type: string;
  actor_name: string;
  action: string;
  entity_type: string;
  request_id: string | null;
}

async function auditoria(): Promise<FilaAuditoria[]> {
  const filas = await db.query<FilaAuditoria>(
    `SELECT actor_type, actor_name, action, entity_type, request_id
       FROM audit_log
      ORDER BY id`,
  );
  return filas.rows;
}

describe("auditoria", () => {
  /**
   * Las once herramientas de la 8.2 en una sola pasada.
   *
   * Se ejercitan TODAS y no solo las que escriben porque la afirmacion que hay
   * que sostener tiene dos mitades: lo que pasa por MCP se registra como AGENT,
   * y las lecturas no dejan nada (7.4). Probar solo las seis escrituras dejaria
   * la segunda mitad sin verificar, que es justo la que se rompe sola.
   */
  it("las once herramientas: las seis que escriben registran AGENT y las cinco que leen no registran", async () => {
    // 1. create_board
    const tablero = await llamar("create_board", { name: "Auditado" });
    expect(tablero.isError, tablero.texto).toBe(false);

    // 2 y 3. Lecturas de tablero.
    expect((await llamar("list_boards", {})).isError).toBe(false);
    expect((await llamar("get_board", { board: "Auditado" })).isError).toBe(false);

    // 4. create_column
    expect(
      (await llamar("create_column", { board: "Auditado", key: "REVIEW", name: "En revision" }))
        .isError,
    ).toBe(false);

    // 5. create_task
    await crear("Auditado", "TODO", "Auditar esto");

    // 6, 7 y 8. Lecturas de tarea.
    expect((await llamar("list_tasks", { board: "Auditado" })).isError).toBe(false);
    expect((await llamar("search_tasks", { text: "Auditar" })).isError).toBe(false);
    expect((await llamar("get_task", { board: "Auditado", task: "Auditar esto" })).isError).toBe(
      false,
    );

    // 9. update_task
    expect(
      (await llamar("update_task", { board: "Auditado", task: "Auditar esto", priority: "HIGH" }))
        .isError,
    ).toBe(false);

    // 10. move_task
    expect(
      (await llamar("move_task", {
        board: "Auditado",
        task: "Auditar esto",
        to_column: "REVIEW",
        position: 0,
      })).isError,
    ).toBe(false);

    // 11. delete_task, en sus dos mitades. La primera NO es una escritura: la
    // confirmacion de la 8.3.2 no toca la base, asi que tampoco se audita.
    const pendiente = await llamar("delete_task", { board: "Auditado", task: "Auditar esto" });
    expect(error(pendiente)["code"]).toBe("CONFIRMATION_REQUIRED");
    const antesDeConfirmar = await auditoria();

    const borrada = await llamar("delete_task", {
      board: "Auditado",
      task: "Auditar esto",
      confirm: true,
    });
    expect(borrada.isError, borrada.texto).toBe(false);

    const filas = await auditoria();
    expect(filas.map((fila) => `${fila.action} ${fila.entity_type}`)).toEqual([
      "CREATE board",
      "CREATE column",
      "CREATE task",
      "UPDATE task",
      "MOVE task",
      "DELETE task",
    ]);
    // La confirmacion pendiente no habia dejado nada: el DELETE aparece recien
    // con la segunda llamada.
    expect(antesDeConfirmar).toHaveLength(filas.length - 1);

    // Todo lo que entra por MCP es AGENT, y el nombre es el del cliente
    // conectado, no una constante del servidor.
    expect(new Set(filas.map((fila) => fila.actor_type))).toEqual(new Set(["AGENT"]));
    expect(new Set(filas.map((fila) => fila.actor_name))).toEqual(new Set(["prueba"]));

    // Un requestId por llamada: si fuera uno por proceso no correlacionaria
    // nada, que es justamente lo que la 5.1 le pide.
    const correlaciones = filas.map((fila) => fila.request_id);
    expect(correlaciones.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect(new Set(correlaciones).size).toBe(filas.length);
  });

  it("una llamada que falla no deja registro", async () => {
    // El tablero se crea por la herramienta y no por `sembrarTablero`: la
    // siembra pasa por los servicios con su propio contexto y dejaria un
    // registro que no es el que esta prueba mira.
    expect((await llamar("create_board", { name: "QA" })).isError).toBe(false);
    const antes = await auditoria();

    const fallida = await llamar("create_task", { board: "QA", column: "NO_EXISTE", title: "X" });
    expect(fallida.isError).toBe(true);

    expect(await auditoria()).toEqual(antes);
  });
});

// --- Trazabilidad (11.1) -----------------------------------------------------

/**
 * El log visto desde el borde, con un logger espia en lugar de pino.
 *
 * Lo que se prueba aca es lo unico que no se puede probar dentro del nucleo: que
 * el `requestId` de la linea `mcp.tool` es EL MISMO que termina en la columna
 * `request_id` de `audit_log`. Son dos caminos distintos —uno va al logger, el
 * otro entra en la transaccion de la escritura— y que coincidan es todo el
 * objetivo de la 11.1: sin eso hay dos identificadores que no se pueden cruzar.
 */
describe("trazabilidad", () => {
  interface Linea {
    campos: CamposDeLog;
  }

  function loggerEspia(): { logger: Logger; lineas: Linea[] } {
    const lineas: Linea[] = [];
    const anotar = (campos: CamposDeLog): void => {
      lineas.push({ campos });
    };
    return {
      lineas,
      logger: {
        debug: anotar,
        info: anotar,
        warn: anotar,
        error: anotar,
      },
    };
  }

  it("el requestId de la linea mcp.tool es el request_id de audit_log", async () => {
    const espia = loggerEspia();
    const conLog = await conectar({ scopes: SCOPES, logger: espia.logger });

    try {
      const creado = await llamarCon(conLog, "create_board", { name: "Trazado" });
      expect(creado.isError, creado.texto).toBe(false);

      const filas = await auditoria();
      expect(filas).toHaveLength(1);

      const linea = espia.lineas.find((actual) => actual.campos["evt"] === "mcp.tool");
      expect(linea?.campos).toMatchObject({
        tool: "create_board",
        outcome: "ok",
        actorType: "AGENT",
        actorName: "prueba",
      });

      // La afirmacion entera de la 11.1 en una linea: el log y la auditoria
      // hablan de la misma peticion, no de dos que pasaron cerca.
      expect(linea?.campos["requestId"]).toBe(filas[0]?.request_id);
    } finally {
      await conLog.close();
    }
  });

  it("una resolucion por nombre queda correlacionada con la escritura que la uso", async () => {
    const espia = loggerEspia();
    const conLog = await conectar({ scopes: SCOPES, logger: espia.logger });

    try {
      expect((await llamarCon(conLog, "create_board", { name: "Trazado" })).isError).toBe(false);
      espia.lineas.length = 0;

      // El tablero y la columna se nombran por texto: dos resoluciones, una
      // escritura, un solo requestId para las tres cosas.
      const creada = await llamarCon(conLog, "create_task", {
        board: "Trazado",
        column: "TODO",
        title: "Revisar HU-25",
      });
      expect(creada.isError, creada.texto).toBe(false);

      const resoluciones = espia.lineas.filter(
        (linea) => linea.campos["evt"] === "mcp.resolve",
      );
      expect(resoluciones.map((linea) => linea.campos["entity"])).toEqual(["board", "column"]);
      expect(resoluciones.map((linea) => linea.campos["strategy"])).toEqual(["exact", "exact"]);

      const filas = await auditoria();
      const creacion = filas.find((fila) => fila.entity_type === "task");
      const ids = new Set(
        [...resoluciones, ...espia.lineas.filter((l) => l.campos["evt"] === "mcp.tool")].map(
          (linea) => linea.campos["requestId"],
        ),
      );

      expect(ids.size).toBe(1);
      expect([...ids][0]).toBe(creacion?.request_id);
    } finally {
      await conLog.close();
    }
  });
});
