import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buscarClavePorPrefijo,
  conCache,
  generarClave,
  hashearClave,
  prefijoDe,
  reiniciarCacheDeClaves,
  ApiKeyService,
  VENTANA_CACHE_MS,
  type ApiKeyRow,
  type BuscadorDeClaves,
  type Scope,
} from "../src/index.js";
import { connectDb, truncateAll, uuid } from "./helpers.js";

/**
 * El cache de verificacion de claves de la 7.1: 60 s en memoria para no consultar
 * la base en cada peticion.
 *
 * TRES NIVELES, y cada uno prueba algo que los otros no pueden:
 *
 *   - Contra `conCache` con un buscador que CUENTA: el vencimiento con reloj
 *     inyectado, que las claves no se pisan y que un fallo no se cachea. Todo
 *     deterministico y sin reloj de pared.
 *   - Contra la base real, CONTANDO las consultas a `api_key`: cinco
 *     autenticaciones seguidas hacen una, y la contraprueba de que sin cache hacen
 *     cinco. Medido y no supuesto.
 *   - La VENTANA DE REVOCACION: revocar por SQL y ver que la clave sigue
 *     autenticando hasta que la entrada vence. Es la consecuencia de la decision y
 *     esta medida, no descrita.
 */

const PEPPER = "pepper-del-cache-en-pruebas";

let client: Client;

beforeAll(async () => {
  client = await connectDb();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
  reiniciarCacheDeClaves();
});

async function sembrarClave(args: {
  clave: string;
  scopes: readonly Scope[];
  revocada?: boolean;
}): Promise<void> {
  await client.query(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, revoked_at)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], $6)`,
    [
      uuid(),
      "clave del cache",
      prefijoDe(args.clave),
      hashearClave(args.clave, PEPPER),
      args.scopes,
      args.revocada === true ? new Date() : null,
    ],
  );
}

/**
 * Cuenta las consultas REALES a `api_key` envolviendo el repositorio.
 *
 * Cada llamada a `buscarClavePorPrefijo` es exactamente un `findUnique` sobre
 * `api_key` —es todo lo que hace ese modulo— asi que contar llamadas es contar
 * consultas, de forma exacta y sin depender del reloj.
 *
 * Los contadores de PostgreSQL (`pg_stat_user_tables`) NO sirven aca, y conviene
 * que quede escrito: el backend acumula sus estadisticas y las publica por
 * intervalo, asi que leerlas justo despues devuelve el valor viejo —medido: delta
 * 0 con el cache y sin el—. Una prueba que las use tiene que esperar o reintentar,
 * o sea volverse dependiente del reloj, que es justo lo que la suite no quiere. La
 * medicion por el lado de PostgreSQL se hizo a mano, contra el servidor de
 * produccion, donde esperar un segundo no cuesta nada.
 */
function repositorioQueCuenta(): { buscar: BuscadorDeClaves; consultas: () => number } {
  let consultas = 0;

  return {
    buscar: async (prefix) => {
      consultas += 1;

      return buscarClavePorPrefijo(prefix);
    },
    consultas: () => consultas,
  };
}

/** Un buscador que cuenta cuantas veces lo llamaron. */
function buscadorQueCuenta(fila: ApiKeyRow | null): { buscar: BuscadorDeClaves; llamadas: () => number } {
  let llamadas = 0;

  return {
    buscar: async (prefix) => {
      llamadas += 1;

      return fila !== null && fila.prefix === prefix ? fila : null;
    },
    llamadas: () => llamadas,
  };
}

function filaDe(clave: string, scopes: readonly Scope[] = ["READ"]): ApiKeyRow {
  return {
    id: uuid(),
    label: "en memoria",
    prefix: prefijoDe(clave),
    keyHash: hashearClave(clave, PEPPER),
    scopes,
    revokedAt: null,
  };
}

describe("conCache", () => {
  it("la segunda busqueda del mismo prefijo no llega al buscador", async () => {
    const clave = generarClave();
    const contador = buscadorQueCuenta(filaDe(clave));
    const cacheado = conCache(contador.buscar);

    await cacheado(prefijoDe(clave));
    await cacheado(prefijoDe(clave));
    await cacheado(prefijoDe(clave));

    expect(contador.llamadas()).toBe(1);
  });

  it("pasados los 60 s vuelve a buscar, con reloj inyectado", async () => {
    const clave = generarClave();
    const contador = buscadorQueCuenta(filaDe(clave));

    let ahora = 1_800_000_000_000;
    const cacheado = conCache(contador.buscar, () => ahora);

    await cacheado(prefijoDe(clave));
    expect(contador.llamadas()).toBe(1);

    // Un milisegundo antes de vencer: sigue sirviendo la entrada.
    ahora += VENTANA_CACHE_MS - 1;
    await cacheado(prefijoDe(clave));
    expect(contador.llamadas()).toBe(1);

    // Justo al vencer. `vence > ahora` es estricto, asi que el borde exacto ya
    // no sirve: preferimos consultar una vez de mas a servir una entrada vieja.
    ahora += 1;
    await cacheado(prefijoDe(clave));
    expect(contador.llamadas()).toBe(2);
  });

  it("claves distintas no se pisan", async () => {
    const unaClave = generarClave();
    const otraClave = generarClave();
    const filas = new Map([
      [prefijoDe(unaClave), filaDe(unaClave, ["READ"])],
      [prefijoDe(otraClave), filaDe(otraClave, ["WRITE"])],
    ]);

    let llamadas = 0;
    const cacheado = conCache(async (prefix) => {
      llamadas += 1;

      return filas.get(prefix) ?? null;
    });

    const primera = await cacheado(prefijoDe(unaClave));
    const segunda = await cacheado(prefijoDe(otraClave));

    expect(llamadas).toBe(2);
    expect(primera?.scopes).toEqual(["READ"]);
    expect(segunda?.scopes).toEqual(["WRITE"]);

    // Y la segunda no desalojo a la primera.
    expect((await cacheado(prefijoDe(unaClave)))?.scopes).toEqual(["READ"]);
    expect(llamadas).toBe(2);
  });

  it("un prefijo que no existe NO se cachea: se consulta cada vez", async () => {
    const contador = buscadorQueCuenta(null);
    const cacheado = conCache(contador.buscar);

    for (let i = 0; i < 5; i += 1) {
      expect(await cacheado("tmk_live_nadie")).toBeNull();
    }

    // Cinco intentos, cinco consultas: es el costo asumido. Mil intentos con la
    // misma clave invalida serian mil consultas, y no las acota el limite de la
    // 7.3 porque se cobra despues de autenticar. Lo que se compra a cambio es que
    // una clave recien emitida autentique en el acto.
    expect(contador.llamadas()).toBe(5);
  });

  it("con la entrada cacheada, una impostora del mismo prefijo sigue sin pasar", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const servicio = new ApiKeyService({ pepper: PEPPER });

    // La valida llena el cache.
    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);

    // El prefijo ACERTADO con el resto cambiado: es el caso que el cache podria
    // haber roto, porque la fila SI se encuentra —viene del cache— y lo unico que
    // separa a esta clave de la buena es la comparacion de hashes, que se hace en
    // cada peticion porque el cache no guarda veredictos.
    const impostora = prefijoDe(clave) + "0".repeat(clave.length - prefijoDe(clave).length);
    expect(impostora).not.toBe(clave);

    expect(await servicio.autenticar(impostora, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });

    // Y la valida sigue siendo valida: el fallo no enveneno la entrada.
    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);
  });

  it("la clave correcta con el hash cambiado en la base tampoco pasa por el cache", async () => {
    // El cache guarda la fila, asi que la comparacion de hashes se hace en cada
    // peticion contra el secreto real. Con un pepper distinto, la misma fila
    // cacheada da un resultado distinto: es la propiedad que un cache de
    // veredictos habria roto.
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    expect((await new ApiKeyService({ pepper: PEPPER }).autenticar(clave, "READ")).ok).toBe(true);
    expect(await new ApiKeyService({ pepper: "otro-pepper" }).autenticar(clave, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });
  });
});

describe("consultas a `api_key`, contadas", () => {
  it("cinco autenticaciones seguidas con la misma clave hacen UNA consulta", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const repo = repositorioQueCuenta();
    const servicio = new ApiKeyService({ pepper: PEPPER, buscar: conCache(repo.buscar) });

    for (let i = 0; i < 5; i += 1) {
      expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);
    }

    expect(repo.consultas()).toBe(1);
  });

  it("CONTRAPRUEBA: sin cache, las mismas cinco hacen CINCO", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    // Inyectar el buscador crudo es apagar el cache: no hay interruptor aparte.
    const repo = repositorioQueCuenta();
    const sinCache = new ApiKeyService({ pepper: PEPPER, buscar: repo.buscar });

    for (let i = 0; i < 5; i += 1) {
      expect((await sinCache.autenticar(clave, "READ")).ok).toBe(true);
    }

    // Si este numero fuera 1, el de arriba no estaria midiendo el cache sino la
    // ausencia de consultas.
    expect(repo.consultas()).toBe(5);
  });

  it("y el defecto del servicio ES el cache: sin inyectar nada, tambien una", async () => {
    // Lo de arriba compone `conCache` a mano para poder contar. Esta prueba cubre
    // que el camino de produccion —`new ApiKeyService({ pepper })`, que es lo que
    // hace `conAuth`— tambien cachea, sin poder contar consultas: si no cacheara,
    // la ventana de revocacion de mas abajo no existiria y esa prueba fallaria.
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const servicio = new ApiKeyService({ pepper: PEPPER });

    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);

    await client.query(`DELETE FROM api_key WHERE prefix = $1`, [prefijoDe(clave)]);

    // La fila ya no existe y la clave sigue autenticando: solo puede venir del
    // cache.
    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);
  });
});

describe("la ventana de revocacion de 60 s", () => {
  it("una clave revocada sigue autenticando hasta que la entrada vence", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    let ahora = 1_800_000_000_000;
    const servicio = new ApiKeyService({
      pepper: PEPPER,
      buscar: conCache(buscarClavePorPrefijo, () => ahora),
    });

    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);

    // La revocacion de hoy: un UPDATE a mano, que es el unico camino que existe.
    await client.query(`UPDATE api_key SET revoked_at = now() WHERE prefix = $1`, [
      prefijoDe(clave),
    ]);

    // LA VENTANA: la base ya dice revocada y la clave sigue autenticando.
    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);

    // Y se cierra sola al vencer la entrada, sin que nadie haga nada.
    ahora += VENTANA_CACHE_MS;
    expect(await servicio.autenticar(clave, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });
  });

  it("`reiniciarCacheDeClaves` la cierra en el acto: es el gancho que usaria un revocador", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const servicio = new ApiKeyService({ pepper: PEPPER });

    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);
    await client.query(`UPDATE api_key SET revoked_at = now() WHERE prefix = $1`, [
      prefijoDe(clave),
    ]);
    expect((await servicio.autenticar(clave, "READ")).ok).toBe(true);

    reiniciarCacheDeClaves();

    expect(await servicio.autenticar(clave, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });
  });
});
