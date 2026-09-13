import type { ListadoDeCoincidencias } from "@taskman/contracts";
import type { BoardDetail, CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as buscar } from "../app/api/tasks/search/route";
import {
  connectDb,
  ctx,
  emitirClave,
  leerError,
  leerJson,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * Contrato REST de GET /api/tasks/search (6.2, RF-09).
 *
 * Mismo enfoque que el resto de la suite. Ver el comentario de cabecera de
 * `boards.test.ts` para el razonamiento completo.
 *
 * LO QUE ESTOS TESTS AFIRMAN ES EL COMPORTAMIENTO REAL DE
 * `to_tsvector('spanish', ...)`, no el que uno esperaria de una busqueda. La
 * diferencia importa y esta medida caso por caso: hay pares con acento que
 * convergen y pares que NO, y el stemmer une el verbo con su gerundio pero no con
 * el sustantivo. Donde el resultado sorprende, el test lo dice en su nombre y en
 * un comentario, para que nadie lo lea como un bug ni lo "arregle" ajustando la
 * asercion.
 */

let client: Client;
let taskman: CorePort;
let claveRead: string;
let claveWrite: string;

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
});

function porKey(tablero: BoardDetail, key: string): string {
  const columna = tablero.columns.find((candidata) => candidata.key === key);
  if (columna === undefined) {
    throw new Error(`El tablero sembrado no tiene una columna con key ${key}.`);
  }
  return columna.id;
}

async function sembrarTarea(args: {
  boardId: string;
  columnKey?: string;
  title: string;
  description?: string;
}): Promise<string> {
  const tarea = await taskman.createTask(
    {
      boardId: args.boardId,
      columnKey: args.columnKey ?? "TODO",
      title: args.title,
      ...(args.description === undefined ? {} : { description: args.description }),
    },
    ctx(),
  );
  return tarea.id;
}

async function resultado(query: string, clave = claveRead): Promise<ListadoDeCoincidencias> {
  const respuesta = await buscar(peticion({ ruta: `/api/tasks/search?${query}`, clave }));
  expect(respuesta.status, `GET /api/tasks/search?${query}`).toBe(200);
  return leerJson<ListadoDeCoincidencias>(respuesta);
}

/** Los titulos que devolvio la busqueda, en el orden de relevancia en que vinieron. */
async function titulos(query: string): Promise<string[]> {
  return (await resultado(query)).items.map((item) => item.title);
}

describe("GET /api/tasks/search", () => {
  describe("donde busca", () => {
    it("encuentra por una palabra del TITLE", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });
      await sembrarTarea({ boardId: tablero.id, title: "Otra cosa" });

      const cuerpo = await resultado(`board_id=${tablero.id}&q=contrato`);

      expect(cuerpo.items.map((item) => item.title)).toEqual(["Revisar el contrato"]);
      // La coincidencia es plana: los campos de la tarea mas `rank`.
      expect(Object.keys(cuerpo.items[0] ?? {}).sort()).toEqual([
        "board_id",
        "column_id",
        "created_at",
        "description",
        "due_date",
        "id",
        "position",
        "priority",
        "rank",
        "title",
        "updated_at",
      ]);
      expect(cuerpo.items[0]?.rank).toBeGreaterThan(0);
    });

    it("encuentra por una palabra de la DESCRIPTION (la 4.2 indexa los dos campos)", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({
        boardId: tablero.id,
        title: "Tarea sin la palabra",
        description: "Validar el contrato con el proveedor",
      });

      expect(await titulos(`board_id=${tablero.id}&q=proveedor`)).toEqual([
        "Tarea sin la palabra",
      ]);
    });

    it("una tarea sin description se indexa igual, por el coalesce del indice", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });

      expect(await titulos(`board_id=${tablero.id}&q=contrato`)).toHaveLength(1);
    });

    it("no distingue mayusculas", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el CONTRATO" });

      expect(await titulos(`board_id=${tablero.id}&q=contrato`)).toHaveLength(1);
      expect(await titulos(`board_id=${tablero.id}&q=CoNtRaTo`)).toHaveLength(1);
    });

    it("200 con lista vacia cuando nada coincide", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });

      expect(await resultado(`board_id=${tablero.id}&q=zanahoria`)).toEqual({
        items: [],
        next_cursor: null,
      });
    });
  });

  describe("acentos: convergen en algunos pares y en otros NO", () => {
    it('"revision" encuentra "revisión" y al reves: ese par CONVERGE', async () => {
      // Las dos formas dan el lexema `revision`: la acentuada solo pierde el
      // acento y la otra queda igual.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisión de la HU-25" });

      expect(await titulos(`board_id=${tablero.id}&q=revision`)).toEqual(["Revisión de la HU-25"]);
      expect(await titulos(`board_id=${tablero.id}&q=revisión`)).toEqual(["Revisión de la HU-25"]);
    });

    it('"aceptacion" NO encuentra "aceptación": ese par NO converge', async () => {
      // Medido contra PostgreSQL: "aceptación" da el lexema `acept` —el stemmer
      // reconoce el sufijo -ación y lo quita— y "aceptacion" sin tilde da
      // `aceptacion`, porque sin el acento no dispara esa regla. Son lexemas
      // distintos y no matchean.
      //
      // O sea que la insensibilidad a acentos de esta busqueda es ACCIDENTAL, no
      // una garantia: depende de si la palabra acentuada dispara una regla del
      // stemmer. No hay `unaccent` en el pipeline. Esta atado como deuda en
      // CLAUDE.md; el test afirma lo que HOY pasa para que el dia que se agregue
      // `unaccent` esto falle y se actualice a proposito.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({
        boardId: tablero.id,
        title: "Criterios de aceptación",
      });

      expect(await titulos(`board_id=${tablero.id}&q=aceptacion`)).toEqual([]);
      // Con la tilde si lo encuentra.
      expect(await titulos(`board_id=${tablero.id}&q=aceptación`)).toEqual([
        "Criterios de aceptación",
      ]);
    });
  });

  describe("stemming del espanol", () => {
    it('"revisar" encuentra "revisando": el verbo y su gerundio comparten raiz', async () => {
      // Los dos dan `revis`.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Estoy revisando el contrato" });

      expect(await titulos(`board_id=${tablero.id}&q=revisar`)).toEqual([
        "Estoy revisando el contrato",
      ]);
    });

    it('"revisar" NO encuentra "revisiones": el verbo y el sustantivo NO comparten raiz', async () => {
      // Medido: "revisar" y "revisando" dan `revis`, pero "revisiones" da
      // `revision`. El stemmer no une la familia entera, solo las flexiones que
      // caen en la misma raiz, asi que esto NO es un bug del query.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Pendiente de revisiones" });

      expect(await titulos(`board_id=${tablero.id}&q=revisar`)).toEqual([]);
      // Y "revision" si lo encuentra, porque comparte lexema con "revisiones".
      expect(await titulos(`board_id=${tablero.id}&q=revision`)).toEqual([
        "Pendiente de revisiones",
      ]);
    });

    it("el plural encuentra el singular y al reves", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Firmar contratos" });

      expect(await titulos(`board_id=${tablero.id}&q=contrato`)).toEqual(["Firmar contratos"]);
    });
  });

  describe("palabra parcial", () => {
    it('"revi" NO encuentra "revisar": la busqueda es por lexema, no por prefijo', async () => {
      // `plainto_tsquery` no agrega `:*`, asi que "revi" es el lexema `revi` y no
      // matchea `revis`. Es informacion util para quien use la API: esto NO es un
      // buscador incremental. Lo mismo que ya esta anotado en la deuda conocida
      // para `auth` y "autenticacion".
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });

      expect(await titulos(`board_id=${tablero.id}&q=revi`)).toEqual([]);
      expect(await titulos(`board_id=${tablero.id}&q=contra`)).toEqual([]);
      // La palabra completa si.
      expect(await titulos(`board_id=${tablero.id}&q=revisar`)).toEqual(["Revisar el contrato"]);
    });
  });

  describe("varias palabras", () => {
    it("actua como AND: todas las palabras tienen que estar", async () => {
      // `plainto_tsquery` une los lexemas con `&`.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({
        boardId: tablero.id,
        title: "Validar criterios",
        description: "del contrato",
      });
      await sembrarTarea({ boardId: tablero.id, title: "Validar otra cosa" });

      // Las dos palabras estan, una en el title y otra en la description.
      expect(await titulos(`board_id=${tablero.id}&q=validar contrato`)).toEqual([
        "Validar criterios",
      ]);
      // "validar" esta en las dos tareas, "zanahoria" en ninguna: AND, no OR.
      expect(await titulos(`board_id=${tablero.id}&q=validar zanahoria`)).toEqual([]);
    });

    it("las palabras vacias del espanol se descartan de la consulta", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });

      // "de la" son palabras vacias: la consulta queda con un solo lexema util.
      expect(await titulos(`board_id=${tablero.id}&q=contrato de la`)).toEqual([
        "Revisar el contrato",
      ]);
    });

    it("200 con lista vacia si el texto es SOLO palabras vacias", async () => {
      // El limite de la validacion del borde: "de la" no esta vacio, asi que pasa
      // el esquema, pero no produce ningun lexema y no matchea nada. El borde
      // valida que dijiste algo, no que lo que dijiste sea buscable.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, title: "Revisar el contrato" });

      expect(await resultado(`board_id=${tablero.id}&q=de la`)).toEqual({
        items: [],
        next_cursor: null,
      });
    });
  });

  describe("ambito", () => {
    it("una tarea de OTRO tablero que coincide NO aparece", async () => {
      // El caso que decide el paso.
      const uno = await sembrarTablero(taskman, { name: "Uno" });
      const otro = await sembrarTablero(taskman, { name: "Otro" });
      await sembrarTarea({ boardId: uno.id, title: "Revisar el contrato del uno" });
      await sembrarTarea({ boardId: otro.id, title: "Revisar el contrato del otro" });

      const cuerpo = await resultado(`board_id=${uno.id}&q=contrato`);

      expect(cuerpo.items.map((item) => item.title)).toEqual(["Revisar el contrato del uno"]);
      expect(cuerpo.items.every((item) => item.board_id === uno.id)).toBe(true);
      expect(cuerpo.items.map((item) => item.title)).not.toContain(
        "Revisar el contrato del otro",
      );
    });

    it("column_id acota a una columna del tablero", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "contrato en TODO" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "DONE", title: "contrato en DONE" });

      expect(
        await titulos(`board_id=${tablero.id}&column_id=${porKey(tablero, "TODO")}&q=contrato`),
      ).toEqual(["contrato en TODO"]);
    });

    it("column_id solo, sin board_id, alcanza", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "contrato en TODO" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "DONE", title: "contrato en DONE" });

      expect(await titulos(`column_id=${porKey(tablero, "DONE")}&q=contrato`)).toEqual([
        "contrato en DONE",
      ]);
    });
  });

  describe("relevancia y paginacion", () => {
    it("ordena por relevancia descendente", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      // La misma palabra repetida puntua mas alto que una sola aparicion.
      await sembrarTarea({ boardId: tablero.id, title: "contrato" });
      await sembrarTarea({
        boardId: tablero.id,
        title: "contrato contrato contrato",
        description: "contrato contrato",
      });

      const cuerpo = await resultado(`board_id=${tablero.id}&q=contrato`);

      expect(cuerpo.items).toHaveLength(2);
      expect(cuerpo.items[0]?.title).toBe("contrato contrato contrato");
      // Y los rank vienen en orden no creciente.
      const ranks = cuerpo.items.map((item) => item.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    });

    it("las paginas completas son el conjunto exacto, sin repetir ni saltear", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      const esperados = new Set<string>();
      for (let i = 0; i < 7; i += 1) {
        esperados.add(
          await sembrarTarea({ boardId: tablero.id, title: `contrato numero ${i}` }),
        );
      }

      const ids: string[] = [];
      let cursor: string | null = null;
      let vueltas = 0;

      do {
        const sufijo = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const pagina = await resultado(`board_id=${tablero.id}&q=contrato&limit=2${sufijo}`);

        expect(pagina.items.length).toBeLessThanOrEqual(2);
        ids.push(...pagina.items.map((item) => item.id));
        cursor = pagina.next_cursor;

        vueltas += 1;
        expect(vueltas, "la paginacion no termina").toBeLessThan(20);
      } while (cursor !== null);

      expect(new Set(ids)).toEqual(esperados);
      expect(ids.length).toBe(esperados.size);
    });

    it("la primera pagina trae limit items y un next_cursor", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      for (let i = 0; i < 5; i += 1) {
        await sembrarTarea({ boardId: tablero.id, title: `contrato ${i}` });
      }

      const pagina = await resultado(`board_id=${tablero.id}&q=contrato&limit=3`);

      expect(pagina.items).toHaveLength(3);
      expect(pagina.next_cursor).not.toBeNull();
    });
  });

  describe("validacion y autorizacion", () => {
    it("400 sin q", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await buscar(
        peticion({ ruta: `/api/tasks/search?board_id=${tablero.id}`, clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con q vacio o de solo espacios", async () => {
      // Devolver 200 con la lista vacia seria indistinguible de "no hubo
      // coincidencias", cuando en realidad no se pidio ninguna busqueda.
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      for (const q of ["", "   ", "\t\n", " "]) {
        const respuesta = await buscar(
          peticion({
            ruta: `/api/tasks/search?board_id=${tablero.id}&q=${encodeURIComponent(q)}`,
            clave: claveRead,
          }),
        );

        expect(respuesta.status, `q=${JSON.stringify(q)} deberia ser 400`).toBe(400);
        expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("400 sin board_id ni column_id", async () => {
      // El nucleo acepta un scope vacio y buscaria en TODOS los tableros; la
      // regla la sostiene el borde, igual que en GET /api/tasks.
      const respuesta = await buscar(
        peticion({ ruta: "/api/tasks/search?q=contrato", clave: claveRead }),
      );

      expect(respuesta.status).toBe(400);
      expect((await leerError(respuesta)).error.code).toBe("VALIDATION_ERROR");
    });

    it("400 con limit fuera de rango", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      for (const limit of ["0", "201", "abc"]) {
        const respuesta = await buscar(
          peticion({
            ruta: `/api/tasks/search?board_id=${tablero.id}&q=contrato&limit=${limit}`,
            clave: claveRead,
          }),
        );

        expect(respuesta.status, `limit=${limit}`).toBe(400);
      }
    });

    it("column_key se IGNORA, no acota ni falla: la busqueda no lo acepta", async () => {
      /**
       * `column_key` NO esta en la busqueda: el `SearchScope` del nucleo solo
       * acepta `columnId`, y resolver la key en el adaptador seria poner una
       * resolucion de referencia en la capa equivocada.
       *
       * Y un parametro de consulta que el contrato no declara NO da 400: el
       * handler arma el objeto a validar leyendo SOLO los parametros que conoce,
       * asi que el `strictObject` nunca ve el de mas. Es el mismo comportamiento
       * de GET /api/boards y GET /api/tasks. El test afirma lo que hoy pasa —y que
       * el parametro queda INERTE, no silenciosamente honrado— porque lo peligroso
       * no es el 200 sino creer que acoto cuando no acoto.
       */
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "TODO", title: "contrato en TODO" });
      await sembrarTarea({ boardId: tablero.id, columnKey: "DONE", title: "contrato en DONE" });

      const cuerpo = await resultado(`board_id=${tablero.id}&q=contrato&column_key=TODO`);

      // Las dos: el parametro no filtro nada.
      expect(cuerpo.items.map((item) => item.title).sort()).toEqual([
        "contrato en DONE",
        "contrato en TODO",
      ]);
    });

    it("401 sin la cabecera Authorization", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await buscar(
        peticion({ ruta: `/api/tasks/search?board_id=${tablero.id}&q=contrato` }),
      );

      expect(respuesta.status).toBe(401);
      expect((await leerError(respuesta)).error.code).toBe("UNAUTHENTICATED");
    });

    it("403 con una clave sin scope read", async () => {
      const tablero = await sembrarTablero(taskman, { name: "Tablero" });

      const respuesta = await buscar(
        peticion({
          ruta: `/api/tasks/search?board_id=${tablero.id}&q=contrato`,
          clave: claveWrite,
        }),
      );

      expect(respuesta.status).toBe(403);
      expect((await leerError(respuesta)).error.details).toEqual({
        required_scope: "read",
        granted_scopes: ["write"],
      });
    });
  });
});
