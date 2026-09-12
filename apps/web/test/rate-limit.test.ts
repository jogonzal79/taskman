import type { CorePort } from "@taskman/core";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as listarTableros } from "../app/api/boards/route.js";
import { POST as crearTarea } from "../app/api/tasks/route.js";
import {
  consumir,
  reiniciarLimiteDePeticiones,
  CUBO_POR_SCOPE,
  LIMITE_POR_CUBO,
  VENTANA_MS,
} from "../lib/rate-limit.js";
import {
  connectDb,
  contarFilas,
  emitirClave,
  leerError,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers.js";

/**
 * Limite de peticiones de la 7.3: 120 por minuto de lectura y 30 de escritura,
 * por clave, con ventana deslizante en memoria.
 *
 * La suite entera corre con el limite APAGADO (ver vitest.config.ts), asi que
 * este archivo lo enciende por prueba y lo devuelve a su sitio despues. Puede
 * hacerlo porque el interruptor se lee por peticion: si se leyera al importar el
 * modulo, encenderlo aca no tendria efecto.
 *
 * Dos niveles, a proposito:
 *
 *   - Lo que se ve desde afuera —el 429, su cuerpo, su Retry-After, que los dos
 *     cupos sean independientes, que sean por clave y que el rechazo no ejecute
 *     nada— va por los Route Handlers reales contra PostgreSQL, como el resto de
 *     la suite de contrato.
 *   - El DESLIZAMIENTO de la ventana va contra `consumir` con el reloj
 *     inyectado. Probarlo por HTTP exigiria esperar un minuto de reloj de verdad
 *     o falsear `Date` globalmente en un archivo que habla con la base por el
 *     driver de pg; el deslizamiento es una propiedad de `consumir`, y ahi se
 *     mide en milisegundos y sin tocar el reloj de nadie.
 */

const LIMITE_ESCRITURA = LIMITE_POR_CUBO[CUBO_POR_SCOPE["write"]];
const LIMITE_LECTURA = LIMITE_POR_CUBO[CUBO_POR_SCOPE["read"]];

let client: Client;
let taskman: CorePort;
let claveWrite: string;
let claveRead: string;
let boardId: string;
let columnId: string;

beforeAll(async () => {
  client = await connectDb();
  taskman = port();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);

  // El registro esta anclado al proceso (globalThis), asi que sin esto una
  // prueba heredaria el cupo que gasto la anterior.
  reiniciarLimiteDePeticiones();
  process.env["RATE_LIMIT_ENABLED"] = "true";

  claveWrite = await emitirClave(client, ["WRITE"], { label: "clave de escritura" });
  claveRead = await emitirClave(client, ["READ"], { label: "clave de lectura" });

  const tablero = await sembrarTablero(taskman, { name: "Tablero del limite" });
  boardId = tablero.id;
  columnId = tablero.columns[0]?.id ?? "";
});

afterEach(() => {
  // El valor que fija vitest.config.ts para el resto de la suite.
  process.env["RATE_LIMIT_ENABLED"] = "false";
});

/**
 * Gasta el cupo de escritura con cuerpos INVALIDOS: son 400, no escriben nada, y
 * cuentan igual. Que cuenten es la semantica que se quiere —el cupo acota
 * peticiones, no operaciones exitosas— y de paso deja la prueba en 30 peticiones
 * sin 30 INSERT.
 */
async function agotarEscritura(clave: string): Promise<void> {
  for (let i = 0; i < LIMITE_ESCRITURA; i += 1) {
    const respuesta = await crearTarea(peticion({ metodo: "POST", ruta: "/api/tasks", clave, cuerpo: {} }));

    expect(respuesta.status).toBe(400);
  }
}

function cuerpoDeTarea(titulo: string): Record<string, unknown> {
  return { board_id: boardId, column_id: columnId, title: titulo };
}

describe("limite de peticiones (7.3)", () => {
  it("devuelve 429 con RATE_LIMITED y Retry-After al superar el cupo de escritura", async () => {
    await agotarEscritura(claveWrite);

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoDeTarea("la que sobra"),
      }),
    );

    expect(respuesta.status).toBe(429);

    const cuerpo = await leerError(respuesta);
    expect(cuerpo.error.code).toBe("RATE_LIMITED");
    expect(cuerpo.error.request_id).toBe(respuesta.headers.get("X-Request-Id"));
    expect(cuerpo.error.details).toMatchObject({
      bucket: "write",
      limit: LIMITE_ESCRITURA,
      window_seconds: 60,
    });

    // Retry-After en SEGUNDOS: un entero positivo, no milisegundos y no una
    // fecha. El tope es la ventana entera.
    const retryAfter = respuesta.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);

    const segundos = Number(retryAfter);
    expect(segundos).toBeGreaterThanOrEqual(1);
    expect(segundos).toBeLessThanOrEqual(VENTANA_MS / 1000);
    expect(cuerpo.error.details?.["retry_after_seconds"]).toBe(segundos);
  });

  it("no mezcla los cupos: agotar el de escritura no impide leer", async () => {
    await agotarEscritura(claveWrite);

    const rechazada = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveWrite, cuerpo: cuerpoDeTarea("no") }),
    );
    expect(rechazada.status).toBe(429);

    // La MISMA clave no puede leer —no tiene scope read— asi que la lectura va
    // con la clave de lectura, que es el caso real: una UI leyendo mientras un
    // agente escribe. Lo que se comprueba es que el cupo de escritura gastado no
    // dejo al sistema sin lecturas.
    const lectura = await listarTableros(peticion({ ruta: "/api/boards", clave: claveRead }));
    expect(lectura.status).toBe(200);
  });

  it("no mezcla los cupos tampoco dentro de una misma clave", async () => {
    const claveTodo = await emitirClave(client, ["READ", "WRITE"], { label: "clave read+write" });

    await agotarEscritura(claveTodo);

    const rechazada = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveTodo, cuerpo: cuerpoDeTarea("no") }),
    );
    expect(rechazada.status).toBe(429);

    const lectura = await listarTableros(peticion({ ruta: "/api/boards", clave: claveTodo }));
    expect(lectura.status).toBe(200);
  });

  it("es por clave: agotar una no afecta a otra", async () => {
    await agotarEscritura(claveWrite);

    const rechazada = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveWrite, cuerpo: cuerpoDeTarea("no") }),
    );
    expect(rechazada.status).toBe(429);

    const otra = await emitirClave(client, ["WRITE"], { label: "la otra clave" });
    const aceptada = await crearTarea(
      peticion({ metodo: "POST", ruta: "/api/tasks", clave: otra, cuerpo: cuerpoDeTarea("si") }),
    );

    expect(aceptada.status).toBe(201);
  });

  it("el 429 NO ejecuta la operacion", async () => {
    await agotarEscritura(claveWrite);

    const tareasAntes = await contarFilas(client, "task");
    // La siembra del tablero ya dejo su registro de auditoria, asi que lo que
    // importa es que NO crezca, no que sea cero.
    const auditoriaAntes = await contarFilas(client, "audit_log");

    const respuesta = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        // Un cuerpo VALIDO: si el limite no cortara antes del handler, esta
        // peticion crearia la tarea.
        cuerpo: cuerpoDeTarea("la que no tiene que existir"),
      }),
    );

    expect(respuesta.status).toBe(429);
    expect(await contarFilas(client, "task")).toBe(tareasAntes);

    // Y no solo no escribio la tarea: no escribio NADA. La 7.4 audita dentro de
    // la transaccion de la operacion, asi que una operacion que no corrio no
    // puede haber dejado registro.
    expect(await contarFilas(client, "audit_log")).toBe(auditoriaAntes);
  });

  it("con RATE_LIMIT_ENABLED apagado no hay 429", async () => {
    process.env["RATE_LIMIT_ENABLED"] = "false";

    // Mas peticiones que el cupo MAS ALTO de los dos.
    for (let i = 0; i < LIMITE_LECTURA + 10; i += 1) {
      const respuesta = await listarTableros(peticion({ ruta: "/api/boards", clave: claveRead }));

      expect(respuesta.status).toBe(200);
    }
  });

  it("apagado tampoco cuenta: al encenderlo el cupo esta entero", async () => {
    process.env["RATE_LIMIT_ENABLED"] = "false";

    for (let i = 0; i < LIMITE_ESCRITURA + 5; i += 1) {
      const respuesta = await crearTarea(
        peticion({ metodo: "POST", ruta: "/api/tasks", clave: claveWrite, cuerpo: {} }),
      );
      expect(respuesta.status).toBe(400);
    }

    process.env["RATE_LIMIT_ENABLED"] = "true";

    const aceptada = await crearTarea(
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpo: cuerpoDeTarea("la primera del cupo"),
      }),
    );

    expect(aceptada.status).toBe(201);
  });
});

/**
 * La ventana es DESLIZANTE y no fija, que es la diferencia que decide si una
 * rafaga puede duplicarse a caballo de dos minutos.
 *
 * El reloj va inyectado, asi que la prueba mide el deslizamiento en
 * milisegundos y no en un minuto de espera real.
 */
describe("ventana deslizante", () => {
  const CLAVE = "clave-de-la-ventana";

  beforeEach(() => {
    reiniciarLimiteDePeticiones();
    process.env["RATE_LIMIT_ENABLED"] = "true";
  });

  it("recupera el cupo de a poco, no de golpe al cambiar de minuto", () => {
    const t0 = 1_800_000_000_000;
    const primerLote = 10;
    const segundoLote = LIMITE_ESCRITURA - primerLote;

    // 10 escrituras en t0 y 20 diez segundos despues: el cupo queda justo.
    for (let i = 0; i < primerLote; i += 1) {
      expect(consumir(CLAVE, "escritura", t0).permitido).toBe(true);
    }

    for (let i = 0; i < segundoLote; i += 1) {
      expect(consumir(CLAVE, "escritura", t0 + 10_000).permitido).toBe(true);
    }

    // Un segundo antes de que se libere la primera marca: rechazada, y falta 1 s.
    const casi = consumir(CLAVE, "escritura", t0 + 59_000);
    expect(casi.permitido).toBe(false);
    expect(casi.permitido === false && casi.esperaSegundos).toBe(1);

    // Pasado el minuto de las 10 primeras se liberan DIEZ lugares, no los 30:
    // con ventana fija habrian vuelto los 30 de una vez.
    const despues = t0 + VENTANA_MS + 1;

    for (let i = 0; i < primerLote; i += 1) {
      expect(consumir(CLAVE, "escritura", despues).permitido).toBe(true);
    }

    const undecima = consumir(CLAVE, "escritura", despues);
    expect(undecima.permitido).toBe(false);

    // Y lo que falta para el lugar siguiente son los 10 s que separaban a los
    // dos lotes, no un minuto entero.
    expect(undecima.permitido === false && undecima.esperaSegundos).toBe(10);
  });

  it("Retry-After decrece a medida que pasa el tiempo", () => {
    const t0 = 1_800_000_000_000;

    for (let i = 0; i < LIMITE_ESCRITURA; i += 1) {
      expect(consumir(CLAVE, "escritura", t0).permitido).toBe(true);
    }

    const enseguida = consumir(CLAVE, "escritura", t0 + 1_000);
    const masTarde = consumir(CLAVE, "escritura", t0 + 30_000);

    expect(enseguida.permitido === false && enseguida.esperaSegundos).toBe(59);
    expect(masTarde.permitido === false && masTarde.esperaSegundos).toBe(30);
  });

  it("los dos cupos y las dos claves cuentan por separado", () => {
    const t0 = 1_800_000_000_000;

    for (let i = 0; i < LIMITE_ESCRITURA; i += 1) {
      expect(consumir(CLAVE, "escritura", t0).permitido).toBe(true);
    }

    expect(consumir(CLAVE, "escritura", t0).permitido).toBe(false);
    expect(consumir(CLAVE, "lectura", t0).permitido).toBe(true);
    expect(consumir("otra-clave", "escritura", t0).permitido).toBe(true);
  });

  it("el reparto de scopes en cupos es el decidido: delete cuenta como escritura", () => {
    // La decision de que cuenta como escritura, fijada. El typecheck obliga a
    // clasificar un scope nuevo, pero no a clasificarlo BIEN: si alguien mueve
    // delete al cupo de lectura, los DELETE pasarian a tener el cupo de 120 y
    // ningun otro test lo notaria.
    expect(CUBO_POR_SCOPE).toEqual({
      read: "lectura",
      write: "escritura",
      delete: "escritura",
    });
  });

  it("el cupo de lectura es el de la 7.3 y tambien corta", () => {
    const t0 = 1_800_000_000_000;

    for (let i = 0; i < LIMITE_LECTURA; i += 1) {
      expect(consumir(CLAVE, "lectura", t0).permitido).toBe(true);
    }

    expect(consumir(CLAVE, "lectura", t0).permitido).toBe(false);
    expect(LIMITE_LECTURA).toBe(120);
    expect(LIMITE_ESCRITURA).toBe(30);
  });

  it("una peticion rechazada no gasta cupo, asi que el bucle no se castiga solo", () => {
    const t0 = 1_800_000_000_000;

    for (let i = 0; i < LIMITE_ESCRITURA; i += 1) {
      expect(consumir(CLAVE, "escritura", t0).permitido).toBe(true);
    }

    // Cien rechazos a mitad de la ventana.
    for (let i = 0; i < 100; i += 1) {
      expect(consumir(CLAVE, "escritura", t0 + 30_000).permitido).toBe(false);
    }

    // Si los rechazos contaran, la ventana estaria llena de marcas de t0+30s y
    // esta peticion seguiria rechazada.
    expect(consumir(CLAVE, "escritura", t0 + VENTANA_MS + 1).permitido).toBe(true);
  });

  it("con el interruptor apagado `consumir` no cuenta nada", () => {
    process.env["RATE_LIMIT_ENABLED"] = "false";

    const t0 = 1_800_000_000_000;

    for (let i = 0; i < LIMITE_ESCRITURA + 50; i += 1) {
      expect(consumir(CLAVE, "escritura", t0).permitido).toBe(true);
    }
  });
});
