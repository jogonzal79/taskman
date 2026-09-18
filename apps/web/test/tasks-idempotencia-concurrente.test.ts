import type { Tarea } from "@taskman/contracts";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { POST as crearTarea } from "../app/api/tasks/route";
import { CABECERA_CLAVE, CABECERA_REPLAY } from "../lib/idempotencia";
import {
  connectDb,
  contarFilas,
  ctx,
  emitirClave,
  peticion,
  port,
  sembrarTablero,
  truncateAll,
} from "./helpers";

/**
 * 10.1, cuarto caso: "Creacion concurrente con la misma Idempotency-Key: se crea
 * exactamente una tarea". Sobre POST /api/tasks, la creacion que la 10.1 nombra.
 *
 * LA CARRERA SE FUERZA, NO SE ESPERA. Dos peticiones lanzadas a la vez pueden no
 * cruzarse nunca: si la primera commitea antes de que la segunda haga la
 * consulta previa de `resolverIdempotencia`, la segunda encuentra la fila y
 * reproduce por el camino SECUENCIAL, y la prueba pasa igual aunque el camino
 * concurrente este roto. Es lo que le pasa a C2 del nucleo: verde y casi
 * insensible. Aca el solapamiento se provoca y se AFIRMA:
 *
 *   1. Una segunda conexion de la prueba toma `FOR UPDATE` sobre las filas de
 *      la columna destino. Es el mismo candado que `lockColumnTasks` pide dentro
 *      de la transaccion de `TaskService.create`, antes de insertar nada.
 *   2. Se lanzan las N peticiones. Cada una hace su consulta previa —nadie
 *      commiteo, asi que ninguna encuentra fila y todas deciden EJECUTAR—, abre
 *      su transaccion y se queda esperando ese candado.
 *   3. La prueba cuenta en `pg_stat_activity` los procesos que esperan un
 *      candado, y exige que sean N. Si alguna hubiera reproducido por el camino
 *      secuencial no estaria esperando, y la cuenta no daria.
 *   4. Recien entonces suelta el candado.
 *
 * O sea que cuando se afirma el resultado, las N pasaron la consulta previa sin
 * encontrar nada y la UNICA defensa contra el duplicado es la PK
 * `(key, client_id)` de `idempotency_record`, escrita DENTRO de la transaccion
 * de la tarea. La columna necesita una tarea previa para que haya filas que
 * bloquear: vacia, `FOR UPDATE` no retiene a nadie.
 *
 * Por eso UNA ronda y no varias como en la prueba de tableros: el cruce esta
 * garantizado por construccion y medido en el paso 3, asi que repetirla no
 * agrega cobertura.
 */

/** Cuantas peticiones identicas compiten. Muy por debajo de las 10 del pool. */
const CONCURRENTES = 5;

const CLAVE_IDEMPOTENCIA = "carrera-de-tareas";

let client: Client;
/** La conexion que retiene el candado de la columna. Separada de la de lectura. */
let candado: Client;
let claveWrite: string;

beforeAll(async () => {
  client = await connectDb();
  candado = await connectDb();
});

afterAll(async () => {
  await candado.end();
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  claveWrite = await emitirClave(client, ["WRITE"]);
});

/**
 * Espera hasta que haya `cuantos` procesos de esta base esperando un candado, o
 * se venza el plazo. Devuelve la ultima cuenta: si no llega, la prueba falla
 * con el numero que vio y no con un tiempo agotado.
 */
async function esperandoCandado(cuantos: number, plazoMs = 10_000): Promise<number> {
  const limite = Date.now() + plazoMs;
  let vistos = 0;

  while (Date.now() < limite) {
    const filas = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'`,
    );
    vistos = filas.rows[0]?.n ?? 0;

    if (vistos >= cuantos) {
      return vistos;
    }

    await new Promise((resolver) => setTimeout(resolver, 25));
  }

  return vistos;
}

describe("POST /api/tasks con la misma Idempotency-Key a la vez (10.1, 6.5)", () => {
  it("N peticiones que se cruzan de verdad crean UNA tarea y responden todas lo mismo", async () => {
    const taskman = port();
    const tablero = await sembrarTablero(taskman, { name: "Carrera" });
    const todo = tablero.columns.find((columna) => columna.key === "TODO");
    if (todo === undefined) {
      throw new Error("El tablero sembrado no tiene columna TODO.");
    }
    await taskman.createTask({ boardId: tablero.id, columnKey: "TODO", title: "previa" }, ctx());

    const cuerpo = JSON.stringify({ board_id: tablero.id, column_key: "TODO", title: "Concurrente" });
    const armar = (): Request =>
      peticion({
        metodo: "POST",
        ruta: "/api/tasks",
        clave: claveWrite,
        cuerpoCrudo: cuerpo,
        cabeceras: { [CABECERA_CLAVE]: CLAVE_IDEMPOTENCIA },
      });

    // 1. El candado de la columna, tomado ANTES de lanzar nada.
    await candado.query("BEGIN");
    await candado.query("SELECT id FROM task WHERE column_id = $1 FOR UPDATE", [todo.id]);

    // 2. Las N, en vuelo. Se quedan esperando el candado dentro de su transaccion.
    const enVuelo = Array.from({ length: CONCURRENTES }, () => crearTarea(armar()));

    // 3 y 4. Contar las que esperan y soltar, pase lo que pase: sin el COMMIT del
    // `finally`, una cuenta que no llega dejaria las N colgadas del candado.
    let esperando: number;
    try {
      esperando = await esperandoCandado(CONCURRENTES);
    } finally {
      await candado.query("COMMIT");
    }

    const respuestas = await Promise.all(enVuelo);

    // El cruce fue real: las N estaban adentro de su transaccion a la vez.
    expect(esperando).toBe(CONCURRENTES);

    // Las respuestas, con el mismo criterio que la prueba de tableros: todas
    // 201, el mismo texto, y una sola ejecutada. Con N peticiones, N-1
    // reproducidas en vez de una. Se cuentan solo las `true`, como alla: la 6.5
    // fija esa cabecera en la reproduccion y no dice nada de la que ejecuto.
    expect(respuestas.map((respuesta) => respuesta.status)).toEqual(
      Array.from({ length: CONCURRENTES }, () => 201),
    );

    const textos = await Promise.all(respuestas.map((respuesta) => respuesta.text()));
    expect(new Set(textos).size).toBe(1);

    const reproducidas = respuestas.filter(
      (respuesta) => respuesta.headers.get(CABECERA_REPLAY) === "true",
    );
    expect(reproducidas).toHaveLength(CONCURRENTES - 1);

    const creada = JSON.parse(textos[0] ?? "") as Tarea;

    // La base: UNA tarea nueva, la misma que dicen las respuestas.
    const nuevas = await client.query<{ id: string }>(
      "SELECT id FROM task WHERE title = 'Concurrente'",
    );
    expect(nuevas.rows).toEqual([{ id: creada.id }]);

    // Un solo CREATE para esa tarea: los intentos abortados se llevaron el suyo.
    const creaciones = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'CREATE' AND entity_type = 'task' AND entity_id = $1`,
      [creada.id],
    );
    expect(creaciones.rows[0]?.n).toBe(1);

    // La columna sigue densa: la previa en 0 y la nueva en 1, sin huecos.
    const posiciones = await client.query<{ title: string; position: number }>(
      "SELECT title, position FROM task WHERE column_id = $1 ORDER BY position",
      [todo.id],
    );
    expect(posiciones.rows).toEqual([
      { title: "previa", position: 0 },
      { title: "Concurrente", position: 1 },
    ]);

    // Y una sola fila de idempotencia, que es la que reprodujeron las demas.
    expect(await contarFilas(client, "idempotency_record")).toBe(1);
  });
});
