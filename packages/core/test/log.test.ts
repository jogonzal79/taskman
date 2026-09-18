import { describe, expect, it } from "vitest";

import {
  crearHerramientas,
  resolverReferencia,
  SCOPES,
  type ActorContext,
  type AmbitoResolucion,
  type BoardDetail,
  type CamposDeLog,
  type Candidato,
  type Llamada,
  type Logger,
  type McpToolDefinition,
  type Page,
  type Task,
  type TaskManagerPort,
} from "../src/index";

/**
 * El log estructurado de la 11.1: la linea por invocacion de herramienta y la
 * linea por resolucion por nombre.
 *
 * No toca la base, como `politica.test.ts`. Lo que hay que sostener aca son dos
 * afirmaciones sobre el borde MCP y no sobre PostgreSQL: que el ejecutor
 * registra UNA linea por llamada con el desenlace correcto, y que la resolucion
 * registra su estrategia. Un puerto falso las ejercita mejor que la base real,
 * porque permite provocar a voluntad el fallo inesperado, que contra una base
 * que anda no se puede pedir.
 */

// --- Doble de logger ---------------------------------------------------------

interface Linea {
  nivel: "debug" | "info" | "warn" | "error";
  campos: CamposDeLog;
  mensaje: string;
}

interface Espia {
  logger: Logger;
  lineas: Linea[];
}

function loggerEspia(): Espia {
  const lineas: Linea[] = [];
  const anotar =
    (nivel: Linea["nivel"]) =>
    (campos: CamposDeLog, mensaje: string): void => {
      lineas.push({ nivel, campos, mensaje });
    };

  return {
    lineas,
    logger: {
      debug: anotar("debug"),
      info: anotar("info"),
      warn: anotar("warn"),
      error: anotar("error"),
    },
  };
}

/** Las lineas de un evento, que es como se las consulta siempre. */
function de(espia: Espia, evt: string): Linea[] {
  return espia.lineas.filter((linea) => linea.campos["evt"] === evt);
}

function unica(espia: Espia, evt: string): CamposDeLog {
  const encontradas = de(espia, evt);
  expect(encontradas, `se esperaba una sola linea ${evt}`).toHaveLength(1);
  return (encontradas[0] as Linea).campos;
}

// --- Doble de puerto ---------------------------------------------------------

const ID_TABLERO = "11111111-1111-4111-8111-111111111111";
const ID_COLUMNA = "22222222-2222-4222-8222-222222222222";
const ID_TAREA = "33333333-3333-4333-8333-333333333333";
const ID_AJENO = "44444444-4444-4444-8444-444444444444";

const AHORA = new Date("2026-01-01T00:00:00.000Z");

const TABLERO: BoardDetail = {
  id: ID_TABLERO,
  name: "QA",
  description: null,
  createdAt: AHORA,
  updatedAt: AHORA,
  columns: [
    {
      id: ID_COLUMNA,
      boardId: ID_TABLERO,
      name: "Por hacer",
      key: "TODO",
      position: 0,
      createdAt: AHORA,
      updatedAt: AHORA,
    },
  ],
};

const TAREA: Task = {
  id: ID_TAREA,
  boardId: ID_TABLERO,
  columnId: ID_COLUMNA,
  title: "Revisar HU-25",
  description: null,
  priority: "MEDIUM",
  dueDate: null,
  position: 0,
  createdAt: AHORA,
  updatedAt: AHORA,
};

function pagina<T>(items: T[]): Page<T> {
  return { items, nextCursor: null };
}

/**
 * Un `TaskManagerPort` de mentira, con lo justo para que las herramientas de
 * este archivo lleguen a donde tienen que llegar. Todo lo que no se sobrescribe
 * lanza: si un test toca un metodo que no preparo, es mejor que falle a que
 * devuelva un vacio plausible.
 */
function puertoFalso(parcial: Partial<TaskManagerPort> = {}): TaskManagerPort {
  const sinPreparar = (metodo: string) => (): never => {
    throw new Error(`El puerto falso no implementa ${metodo}.`);
  };

  const base: TaskManagerPort = {
    listBoards: async () => pagina([TABLERO]),
    getBoard: async (boardId: string) => {
      if (boardId !== TABLERO.id) {
        throw new Error(`El puerto falso no conoce el tablero ${boardId}.`);
      }
      return TABLERO;
    },
    listTasks: async () => pagina([TAREA]),
    getTask: async (taskId: string) => {
      if (taskId !== TAREA.id) {
        throw new Error(`El puerto falso no conoce la tarea ${taskId}.`);
      }
      return TAREA;
    },
    searchTasks: async () => pagina([]),
    createBoard: sinPreparar("createBoard"),
    createColumn: sinPreparar("createColumn"),
    createTask: sinPreparar("createTask"),
    updateTask: sinPreparar("updateTask"),
    moveTask: sinPreparar("moveTask"),
    deleteTask: sinPreparar("deleteTask"),
  };

  return { ...base, ...parcial };
}

const ACTOR: ActorContext = {
  actorType: "AGENT",
  actorName: "claude-code",
  requestId: "req-de-prueba",
};

/** Las herramientas montadas contra el espia, con un contexto conocido. */
function herramientas(espia: Espia, port: TaskManagerPort): McpToolDefinition[] {
  return crearHerramientas(port, { scopes: SCOPES, logger: espia.logger, contexto: () => ACTOR });
}

function herramienta(espia: Espia, port: TaskManagerPort, nombre: string): McpToolDefinition {
  const encontrada = herramientas(espia, port).find((h) => h.name === nombre);
  if (encontrada === undefined) {
    throw new Error(`No existe la herramienta ${nombre}.`);
  }
  return encontrada;
}

// --- El ejecutor (mcp.tool) --------------------------------------------------

describe("linea mcp.tool", () => {
  it("una sola linea por invocacion, con outcome ok en el camino feliz", async () => {
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "list_boards").handler({});

    expect(salida.isError ?? false).toBe(false);

    const campos = unica(espia, "mcp.tool");
    expect(campos).toMatchObject({
      evt: "mcp.tool",
      tool: "list_boards",
      requestId: ACTOR.requestId,
      actorType: "AGENT",
      actorName: "claude-code",
      outcome: "ok",
    });
    // Sin `code`: la 11.1 lo pide solo cuando hubo error de dominio, y una
    // clave presente con valor nulo no es lo mismo que ausente al filtrar.
    expect(campos["code"]).toBeUndefined();
    expect(typeof campos["durationMs"]).toBe("number");
    expect(campos["durationMs"] as number).toBeGreaterThanOrEqual(0);
  });

  it("un error de dominio es outcome domain_error y lleva su code", async () => {
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "get_board").handler({
      board: "Tablero que no existe",
    });

    expect(salida.isError).toBe(true);
    expect(unica(espia, "mcp.tool")).toMatchObject({
      tool: "get_board",
      outcome: "domain_error",
      code: "BOARD_NOT_FOUND",
    });
  });

  it("argumentos invalidos tambien son domain_error, con VALIDATION_ERROR", async () => {
    // El fallo ocurre ANTES del cuerpo de la herramienta. Si la linea se
    // emitiera desde adentro, esta invocacion no dejaria ninguna.
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "list_boards").handler({ limit: 0 });

    expect(salida.isError).toBe(true);
    expect(unica(espia, "mcp.tool")).toMatchObject({
      tool: "list_boards",
      outcome: "domain_error",
      code: "VALIDATION_ERROR",
    });
  });

  it("un fallo inesperado es outcome error, va en nivel error y no lleva code", async () => {
    const espia = loggerEspia();
    const port = puertoFalso({
      listBoards: () => {
        throw new Error("la base se cayo");
      },
    });

    const salida = await herramienta(espia, port, "list_boards").handler({});

    expect(salida.isError).toBe(true);
    const lineas = de(espia, "mcp.tool");
    expect(lineas).toHaveLength(1);
    expect((lineas[0] as Linea).nivel).toBe("error");
    expect((lineas[0] as Linea).campos).toMatchObject({ outcome: "error" });
    // INTERNAL_ERROR es una etiqueta del borde, no un codigo de dominio:
    // ponerlo en `code` lo volveria indistinguible de uno que si lo es.
    expect((lineas[0] as Linea).campos["code"]).toBeUndefined();
  });

  it("un fallo inesperado NO expone la causa y SI el request_id; la traza queda en el log (6.4, 11.1)", async () => {
    const espia = loggerEspia();
    const port = puertoFalso({
      listBoards: () => {
        throw new Error("relation \"board\" does not exist");
      },
    });

    const salida = await herramienta(espia, port, "list_boards").handler({});
    const texto = salida.content[0]?.text ?? "";
    const linea = (de(espia, "mcp.tool")[0] as Linea).campos;

    // La causa no sale: ni en el texto ni en el JSON.
    expect(texto).not.toContain("does not exist");
    expect(texto).toContain("INTERNAL_ERROR");
    // El request_id si, y es el de la linea.
    expect(texto).toContain(`"request_id": "${String(linea["requestId"])}"`);
    // Y la causa entera esta en la linea, con su stack.
    expect(linea["err"]).toMatchObject({ type: "Error", message: 'relation "board" does not exist' });
    expect(String((linea["err"] as { stack: unknown }).stack)).toContain("Error:");
  });

  it("un error DEVUELTO y no lanzado tampoco pasa por ok: delete_task sin confirm", async () => {
    // Es el unico caso del catalogo en el que la herramienta responde con un
    // error por `return`. Sin mirar el resultado, el ejecutor lo registraria
    // como una llamada exitosa, que es justo lo que hay que poder diagnosticar.
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "delete_task").handler({
      task: ID_TAREA,
      board: ID_TABLERO,
    });

    expect(salida.isError).toBe(true);
    expect(unica(espia, "mcp.tool")).toMatchObject({
      tool: "delete_task",
      outcome: "domain_error",
      code: "CONFIRMATION_REQUIRED",
    });
  });

  it("dos invocaciones no comparten requestId", async () => {
    // Con el contexto real, uno por llamada: si fuera uno por proceso no
    // correlacionaria nada. Por eso este test no pasa `contexto`.
    const espia = loggerEspia();
    const lista = crearHerramientas(puertoFalso(), { scopes: SCOPES, logger: espia.logger }).find(
      (h) => h.name === "list_boards",
    ) as McpToolDefinition;

    await lista.handler({});
    await lista.handler({});

    const ids = de(espia, "mcp.tool").map((linea) => linea.campos["requestId"]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// --- La resolucion por nombre (mcp.resolve) ----------------------------------

const AMBITO: AmbitoResolucion = {
  entidad: "tarea",
  plural: "tareas",
  genero: "f",
  campo: "task",
  etiqueta: "title",
  entity: "task",
  notFound: "TASK_NOT_FOUND",
};

const CANDIDATOS: Candidato[] = [
  { id: ID_TAREA, label: "Revisar HU-25" },
  { id: ID_AJENO, label: "Revisar HU-26" },
];

function resolverCon(espia: Espia, referencia: string, candidatos = CANDIDATOS): Candidato {
  const llamada: Llamada = { ctx: ACTOR, logger: espia.logger };
  return resolverReferencia(referencia, candidatos, AMBITO, llamada);
}

describe("linea mcp.resolve", () => {
  it("uuid: estrategia uuid, una coincidencia y el id resuelto", () => {
    const espia = loggerEspia();
    expect(resolverCon(espia, ID_TAREA).id).toBe(ID_TAREA);

    expect(unica(espia, "mcp.resolve")).toEqual({
      evt: "mcp.resolve",
      requestId: ACTOR.requestId,
      entity: "task",
      strategy: "uuid",
      matches: 1,
      resolvedId: ID_TAREA,
    });
  });

  it("titulo exacto: estrategia exact, una coincidencia y el id resuelto", () => {
    const espia = loggerEspia();
    expect(resolverCon(espia, "Revisar HU-25").id).toBe(ID_TAREA);

    expect(unica(espia, "mcp.resolve")).toMatchObject({
      entity: "task",
      strategy: "exact",
      matches: 1,
      resolvedId: ID_TAREA,
    });
  });

  it("ambiguo: la estrategia y cuantos, y NINGUN id resuelto", () => {
    const espia = loggerEspia();
    const homonimas: Candidato[] = [
      { id: ID_TAREA, label: "Revisar" },
      { id: ID_AJENO, label: "Revisar" },
    ];

    expect(() => resolverCon(espia, "Revisar", homonimas)).toThrow(/coinciden/);

    const campos = unica(espia, "mcp.resolve");
    expect(campos).toMatchObject({ strategy: "exact", matches: 2 });
    // Anotar el primero seria escribir en el log justamente la eleccion que la
    // 8.3.1 prohibe hacer.
    expect(campos["resolvedId"]).toBeUndefined();
  });

  it("parcial: se registra la busqueda que decide, no la exacta que fallo", () => {
    const espia = loggerEspia();
    expect(resolverCon(espia, "HU-25").id).toBe(ID_TAREA);

    expect(unica(espia, "mcp.resolve")).toMatchObject({ strategy: "partial", matches: 1 });
  });

  it("sin coincidencias: partial con cero, y el NOT_FOUND queda en la linea de la herramienta", () => {
    const espia = loggerEspia();
    expect(() => resolverCon(espia, "Nada que ver")).toThrow();

    const campos = unica(espia, "mcp.resolve");
    expect(campos).toMatchObject({ strategy: "partial", matches: 0 });
    expect(campos["resolvedId"]).toBeUndefined();
  });

  it("el titulo va en debug y nunca en info", () => {
    const espia = loggerEspia();
    resolverCon(espia, "Revisar HU-25");

    const info = espia.lineas.filter((linea) => linea.nivel === "info");
    expect(info).toHaveLength(1);
    expect(JSON.stringify(info[0]?.campos)).not.toContain("Revisar HU-25");

    // En debug si: sin la referencia cruda no se puede reconstruir que pidio el
    // agente, que es para lo que la 11.1 quiere este log.
    const debug = espia.lineas.filter((linea) => linea.nivel === "debug");
    expect(debug).toHaveLength(1);
    expect(debug[0]?.campos).toMatchObject({
      evt: "mcp.resolve.ref",
      requestId: ACTOR.requestId,
      entity: "task",
      field: "task",
      reference: "Revisar HU-25",
    });
  });
});

// --- La correlacion, que es el objetivo de la 11.1 ---------------------------

describe("correlacion", () => {
  it("la resolucion y la invocacion que la pidio comparten requestId", async () => {
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "get_task").handler({
      board: "QA",
      task: "Revisar HU-25",
    });

    expect(salida.isError ?? false).toBe(false);

    // Dos resoluciones —el tablero por nombre y la tarea por titulo— y una sola
    // invocacion. Las tres lineas llevan el mismo id.
    const resoluciones = de(espia, "mcp.resolve");
    expect(resoluciones.map((linea) => linea.campos["entity"])).toEqual(["board", "task"]);

    const ids = [...resoluciones, ...de(espia, "mcp.tool")].map(
      (linea) => linea.campos["requestId"],
    );
    expect(new Set(ids)).toEqual(new Set([ACTOR.requestId]));
  });

  it("resolver por id tambien deja linea, con estrategia uuid", async () => {
    // Es el dato que distingue a un agente que encadena por id de uno que
    // adivina nombres, y el que se perderia si el atajo por UUID salteara la
    // resolucion en vez de pasar por ella con la lista de candidatos vacia.
    const espia = loggerEspia();
    const salida = await herramienta(espia, puertoFalso(), "get_task").handler({
      board: ID_TABLERO,
      task: ID_TAREA,
    });

    expect(salida.isError ?? false).toBe(false);
    expect(de(espia, "mcp.resolve").map((linea) => linea.campos["strategy"])).toEqual([
      "uuid",
      "uuid",
    ]);
  });
});
