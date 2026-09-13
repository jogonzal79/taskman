import type { ListadoDeAuditoria, RegistroDeAuditoria, Tarea } from "@taskman/contracts";
import type { BoardDetail, CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as consultarAuditoria } from "../app/api/audit/route";
import { POST as crearTarea } from "../app/api/tasks/route";
import { DELETE as borrarTarea, PATCH as actualizarTarea } from "../app/api/tasks/[id]/route";
import { POST as moverTarea } from "../app/api/tasks/[id]/move/route";
import {
  connectDb,
  contarFilas,
  contextoDeRuta,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de GET /api/audit (6.2 fila GET /api/audit, RF-10).
 *
 * A diferencia del resto de la suite, casi todos los casos de aca generan los
 * registros POR LA API —crear, mover y borrar tareas con sus handlers— en vez
 * de sembrarlos por el `CorePort`. Es deliberado: lo que se prueba es que el
 * log refleje lo que paso por el borde, con su actor, su client_id y su
 * request_id, y sembrar por el nucleo dejaria fuera justamente esa parte.
 */

/** Las claves de `registroDeAuditoria` (contracts), los campos de la 4.1. */
const CLAVES_REGISTRO = [
  "action",
  "actor_name",
  "actor_type",
  "after_data",
  "before_data",
  "client_id",
  "created_at",
  "entity_id",
  "entity_type",
  "id",
  "request_id",
];

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveWrite: string;
let claveTodo: string;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveRead = await emitirClave(client, ["READ"]);
  claveWrite = await emitirClave(client, ["WRITE"]);
  claveTodo = await emitirClave(client, ["READ", "WRITE", "DELETE"], { label: "clave completa" });
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

/** GET /api/audit con la query indicada. Devuelve el cuerpo ya parseado. */
async function auditoria(query = "", clave = claveRead): Promise<ListadoDeAuditoria> {
  const respuesta = await consultarAuditoria(
    peticion({ ruta: `/api/audit${query === "" ? "" : `?${query}`}`, clave }),
  );

  expect(respuesta.status).toBe(200);
  return leerJson<ListadoDeAuditoria>(respuesta);
}

/** Crea una tarea por el borde y devuelve su cuerpo. */
async function crearPorElBorde(
  boardId: string,
  title: string,
): Promise<{ tarea: Tarea; requestId: string }> {
  const respuesta = await crearTarea(
    peticion({
      metodo: "POST",
      ruta: "/api/tasks",
      clave: claveTodo,
      cuerpo: { board_id: boardId, column_key: "TODO", title },
    }),
  );

  expect(respuesta.status).toBe(201);
  return {
    tarea: await leerJson<Tarea>(respuesta),
    requestId: respuesta.headers.get("X-Request-Id") ?? "",
  };
}

describe("GET /api/audit", () => {
  it("200 con los registros reales de crear, mover y borrar una tarea", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const { tarea } = await crearPorElBorde(tablero.id, "Revisar HU-25");

    const movida = await moverTarea(
      peticion({
        metodo: "POST",
        ruta: `/api/tasks/${tarea.id}/move`,
        clave: claveTodo,
        cuerpo: { column_key: "DONE", position: 0 },
      }),
      contextoDeRuta(tarea.id),
    );
    expect(movida.status).toBe(200);

    const borrada = await borrarTarea(
      peticion({ metodo: "DELETE", ruta: `/api/tasks/${tarea.id}`, clave: claveTodo }),
      contextoDeRuta(tarea.id),
    );
    expect(borrada.status).toBe(204);

    const cuerpo = await auditoria(`entity_type=task&entity_id=${tarea.id}`);

    expect(cuerpo.items.map((registro) => registro.action)).toEqual(["DELETE", "MOVE", "CREATE"]);
    for (const registro of cuerpo.items) {
      expect(registro.entity_id).toBe(tarea.id);
      expect(registro.entity_type).toBe("task");
    }
    // La forma completa de la 4.1, sin campos de mas ni de menos.
    expect(Object.keys(cuerpo.items[0] ?? {}).sort()).toEqual(CLAVES_REGISTRO);
  });

  it("200 con before_data y after_data completos, como los escribe la 7.4", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const { tarea } = await crearPorElBorde(tablero.id, "Con payloads");

    await actualizarTarea(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${tarea.id}`,
        clave: claveTodo,
        cuerpo: { title: "Renombrada" },
      }),
      contextoDeRuta(tarea.id),
    );

    const cuerpo = await auditoria(`entity_type=task&entity_id=${tarea.id}`);
    const [update, create] = cuerpo.items;

    // CREATE: before null, after con la entidad entera.
    expect(create?.action).toBe("CREATE");
    expect(create?.before_data).toBeNull();
    expect(create?.after_data).toMatchObject({ id: tarea.id, title: "Con payloads" });

    // UPDATE: solo los campos modificados, en las dos puntas.
    expect(update?.action).toBe("UPDATE");
    expect(update?.before_data).toEqual({ title: "Con payloads" });
    expect(update?.after_data).toEqual({ title: "Renombrada" });
  });

  it("filtra por entity_type + entity_id: la historia de esa entidad y nada mas", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const { tarea: unaTarea } = await crearPorElBorde(tablero.id, "la que miro");
    const { tarea: otraTarea } = await crearPorElBorde(tablero.id, "la otra");

    await actualizarTarea(
      peticion({
        metodo: "PATCH",
        ruta: `/api/tasks/${unaTarea.id}`,
        clave: claveTodo,
        cuerpo: { priority: "HIGH" },
      }),
      contextoDeRuta(unaTarea.id),
    );

    const cuerpo = await auditoria(`entity_type=task&entity_id=${unaTarea.id}`);

    // Dos registros de la tarea mirada, ninguno de la otra ni del tablero.
    expect(cuerpo.items).toHaveLength(2);
    expect(cuerpo.items.map((registro) => registro.entity_id)).toEqual([unaTarea.id, unaTarea.id]);
    expect(cuerpo.items.map((registro) => registro.action)).toEqual(["UPDATE", "CREATE"]);
    expect(cuerpo.items.map((registro) => registro.entity_id)).not.toContain(otraTarea.id);
  });

  it("filtra por entity_type solo, que es prefijo del indice", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await crearPorElBorde(tablero.id, "una");
    await crearPorElBorde(tablero.id, "otra");

    const tareas = await auditoria("entity_type=task");
    const tableros = await auditoria("entity_type=board");

    expect(tareas.items).toHaveLength(2);
    expect(tareas.items.every((registro) => registro.entity_type === "task")).toBe(true);
    // El tablero sembrado dejo su propio CREATE.
    expect(tableros.items).toHaveLength(1);
    expect(tableros.items[0]?.entity_id).toBe(tablero.id);
  });

  it("400 con entity_id sin entity_type: no es prefijo del indice", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });

    const respuesta = await consultarAuditoria(
      peticion({ ruta: `/api/audit?entity_id=${tablero.id}`, clave: claveRead }),
    );

    expect(respuesta.status).toBe(400);

    const error = (await leerError(respuesta)).error;

    expect(error.code).toBe("VALIDATION_ERROR");
    // El 400 dice POR QUE, que es lo unico que vuelve accionable un limite que
    // el cliente no puede adivinar.
    expect(JSON.stringify(error.details)).toContain("indice");
  });

  it("ordena de mas reciente primero", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const titulos = ["t-0", "t-1", "t-2", "t-3"];

    for (const title of titulos) {
      await crearPorElBorde(tablero.id, title);
    }

    const cuerpo = await auditoria("entity_type=task");

    // Al reves del orden en que ocurrieron, que es lo util en un log.
    expect(
      cuerpo.items.map((registro) => (registro.after_data as { title?: string }).title),
    ).toEqual([...titulos].reverse());

    // Y el id, que es la clave del orden, va estrictamente decreciente.
    const ids = cuerpo.items.map((registro) => BigInt(registro.id));
    for (let i = 1; i < ids.length; i += 1) {
      expect((ids[i - 1] as bigint) > (ids[i] as bigint)).toBe(true);
    }
  });

  it("filtra por rango sobre created_at, exclusivo en las dos puntas", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await crearPorElBorde(tablero.id, "vieja");

    const corte = new Date();
    // La columna es timestamp(3): sin este margen las dos tandas podrian caer
    // en el mismo milisegundo y el corte no separaria nada.
    await new Promise((resolver) => setTimeout(resolver, 20));

    await crearPorElBorde(tablero.id, "nueva");

    const despues = await auditoria(
      `entity_type=task&created_after=${encodeURIComponent(corte.toISOString())}`,
    );
    const antes = await auditoria(
      `entity_type=task&created_before=${encodeURIComponent(corte.toISOString())}`,
    );

    expect(despues.items.map((r) => (r.after_data as { title?: string }).title)).toEqual(["nueva"]);
    expect(antes.items.map((r) => (r.after_data as { title?: string }).title)).toEqual(["vieja"]);
  });

  describe("paginacion por cursor con id bigint", () => {
    it("el recorrido completo devuelve el conjunto exacto, sin repetir ni saltear", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      // 7 tareas: mas registros que el limite de pagina que voy a pedir.
      for (let i = 0; i < 7; i += 1) {
        await crearPorElBorde(tablero.id, `t-${i}`);
      }

      // Lo que hay en la base, leido por SQL. `pg` devuelve int8 como TEXTO y
      // Prisma como bigint, asi que los dos lados se normalizan a string antes
      // de comparar: es el detalle que hace que esta comparacion signifique
      // algo.
      const filas = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM audit_log ORDER BY id DESC`,
      );
      const esperados = filas.rows.map((fila) => fila.id);
      expect(esperados).toHaveLength(8); // 7 tareas + el tablero

      const vistos: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;

      do {
        const query: string = `limit=3${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const pagina: ListadoDeAuditoria = await auditoria(query);
        paginas += 1;
        vistos.push(...pagina.items.map((registro) => registro.id));
        cursor = pagina.next_cursor;
        expect(paginas).toBeLessThan(10); // red contra un cursor que no avanza
      } while (cursor !== null);

      // Union exacta, en el mismo orden, sin duplicados.
      expect(vistos).toEqual(esperados);
      expect(new Set(vistos).size).toBe(vistos.length);
      expect(paginas).toBe(3); // 3 + 3 + 2
    });

    it("next_cursor es null en la ultima pagina", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await crearPorElBorde(tablero.id, "unica");

      const cuerpo = await auditoria("limit=200");

      expect(cuerpo.next_cursor).toBeNull();
      expect(cuerpo.items).toHaveLength(2);
    });

    it("un cursor invalido se IGNORA y devuelve la primera pagina", async () => {
      // Mismo comportamiento heredado que GET /api/boards, GET /api/tasks y la
      // busqueda: `decodificar` devuelve undefined ante cualquier cosa que no
      // decodifique y la condicion no se aplica. Se repite a proposito para que
      // los cinco listados respondan igual; queda atado para que el dia que se
      // decida que tiene que ser un 400, sea un cambio de los cinco.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await crearPorElBorde(tablero.id, "una");

      const cuerpo = await auditoria("cursor=no-es-un-cursor");

      expect(cuerpo.items).toHaveLength(2);
    });

    it("el id viaja como texto decimal y no como numero", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await crearPorElBorde(tablero.id, "una");

      const cuerpo = await auditoria();
      const registro = cuerpo.items[0] as RegistroDeAuditoria;

      expect(typeof registro.id).toBe("string");
      expect(registro.id).toMatch(/^\d+$/);
    });
  });

  it("las LECTURAS no se auditan (7.4)", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    await crearPorElBorde(tablero.id, "la unica escritura");

    const antes = await contarFilas(client, "audit_log");
    expect(antes).toBe(2); // el tablero y la tarea

    // Varios GET, incluidos los que filtran y los que paginan.
    for (const query of ["", "entity_type=task", "limit=1", `entity_type=board&entity_id=${tablero.id}`]) {
      await auditoria(query);
    }

    // Ni una fila nueva. Si las lecturas se auditaran, el log crece con cada
    // consulta y termina auditandose a si mismo.
    expect(await contarFilas(client, "audit_log")).toBe(antes);

    // Y la ultima consulta sigue viendo exactamente lo mismo que la primera.
    const cuerpo = await auditoria();
    expect(cuerpo.items).toHaveLength(2);
    expect(cuerpo.items.map((registro) => registro.entity_type).sort()).toEqual(["board", "task"]);
  });

  it("una escritura por REST queda como API, con el client_id y el request_id de la peticion", async () => {
    const tablero = await sembrarTablero(taskman, { name: "Tablero" });
    const { tarea, requestId } = await crearPorElBorde(tablero.id, "por el borde");

    const cuerpo = await auditoria(`entity_type=task&entity_id=${tarea.id}`);
    const registro = cuerpo.items[0];

    // 7.4: API para los clientes REST. El actor_name es la etiqueta de la clave
    // y el client_id su prefijo publico.
    expect(registro?.actor_type).toBe("API");
    expect(registro?.actor_name).toBe("clave completa");
    expect(registro?.client_id).toMatch(/^tmk_live_/);
    // 6.1: el request_id del registro es el X-Request-Id de la respuesta que lo
    // genero, que es lo unico que los correlaciona.
    expect(registro?.request_id).toBe(requestId);
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/);
  });

  describe("validacion y autorizacion", () => {
    it("400 con un entity_type que no es una entidad del dominio", async () => {
      const respuesta = await consultarAuditoria(
        peticion({ ruta: "/api/audit?entity_type=api_key", clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con un limit que no es numero", async () => {
      const respuesta = await consultarAuditoria(
        peticion({ ruta: "/api/audit?limit=abc", clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("403 con una clave sin scope read", async () => {
      const respuesta = await consultarAuditoria(
        peticion({ ruta: "/api/audit", clave: claveWrite }),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "read",
        granted_scopes: ["write"],
      });
    });

    it("401 sin clave", async () => {
      const respuesta = await consultarAuditoria(peticion({ ruta: "/api/audit" }));

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    });

    it("200 con scope read alcanza: el log es un GET mas (7.2)", async () => {
      const respuesta = await consultarAuditoria(
        peticion({ ruta: "/api/audit", clave: claveRead }),
      );

      expect(respuesta.status).toBe(200);
      expect(respuesta.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{32}$/);
      expect(respuesta.headers.get("Cache-Control")).toBe("no-store");
    });
  });
});
