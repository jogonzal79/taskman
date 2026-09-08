import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ApiKeyService,
  generarClave,
  hashearClave,
  hashesIguales,
  prefijoDe,
  PREFIJO_CLAVE,
  type ApiKeyRow,
  type Scope,
} from "../src/index.js";
import { connectDb, truncateAll, uuid } from "./helpers.js";

/**
 * API keys: ADR-005, 7.1 y 7.2.
 *
 * El servicio se prueba contra la base real como el resto de la suite, pero el
 * pepper NUNCA sale de process.env: se inyecta, que es justamente lo que la
 * inyeccion compra. Por eso hay tambien un caso con DOS peppers distintos, que
 * seria imposible de escribir si el nucleo lo leyera del entorno.
 */

const PEPPER = "pepper-de-pruebas";

let client: Client;

beforeAll(async () => {
  client = await connectDb();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await truncateAll(client);
});

async function sembrarClave(args: {
  clave: string;
  scopes: readonly Scope[];
  pepper?: string;
  revocada?: boolean;
  label?: string;
}): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO api_key (id, label, prefix, key_hash, scopes, revoked_at)
     VALUES ($1, $2, $3, $4, $5::"Scope"[], $6)`,
    [
      id,
      args.label ?? "clave de prueba",
      prefijoDe(args.clave),
      hashearClave(args.clave, args.pepper ?? PEPPER),
      args.scopes,
      args.revocada === true ? new Date() : null,
    ],
  );
  return id;
}

function servicio(pepper = PEPPER): ApiKeyService {
  return new ApiKeyService({ pepper });
}

describe("generarClave", () => {
  it("respeta el formato de la 7.1 y no se repite", () => {
    const clave = generarClave();

    expect(clave.startsWith(PREFIJO_CLAVE)).toBe(true);
    // 32 bytes en base62 son 43 caracteres, siempre: se rellena a la izquierda
    // para que una clave con bytes en cero adelante no salga mas corta.
    expect(clave).toHaveLength(PREFIJO_CLAVE.length + 43);
    expect(clave.slice(PREFIJO_CLAVE.length)).toMatch(/^[0-9A-Za-z]+$/);

    const muchas = new Set(Array.from({ length: 200 }, () => generarClave()));
    expect(muchas.size).toBe(200);
  });

  it("el prefijo visible son tmk_live_ mas 6 caracteres", () => {
    const clave = generarClave();
    expect(prefijoDe(clave)).toHaveLength(PREFIJO_CLAVE.length + 6);
    expect(clave.startsWith(prefijoDe(clave))).toBe(true);
  });
});

describe("hashearClave", () => {
  it("es un SHA-256 hex estable", () => {
    const clave = generarClave();
    expect(hashearClave(clave, PEPPER)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashearClave(clave, PEPPER)).toBe(hashearClave(clave, PEPPER));
  });

  it("el pepper cambia el hash: es lo que lo hace algo mas que un SHA-256", () => {
    const clave = generarClave();
    expect(hashearClave(clave, PEPPER)).not.toBe(hashearClave(clave, "otro-pepper"));
  });

  it("hashesIguales no lanza ante largos distintos", () => {
    // timingSafeEqual lanza si los buffers difieren en largo; la guarda previa
    // es lo que evita que una fila corrupta tumbe la peticion.
    expect(hashesIguales("abc", "abcdef")).toBe(false);
    expect(hashesIguales("abc", "abc")).toBe(true);
  });
});

describe("ApiKeyService.autenticar", () => {
  it("una clave valida con el scope pedido autentica", async () => {
    const clave = generarClave();
    const id = await sembrarClave({ clave, scopes: ["READ"], label: "solo lectura" });

    const resultado = await servicio().autenticar(clave, "READ");

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.clave.id).toBe(id);
    expect(resultado.clave.label).toBe("solo lectura");
    expect(resultado.clave.prefix).toBe(prefijoDe(clave));
    expect(resultado.clave.scopes).toEqual(["READ"]);
  });

  it("una clave con varios scopes sirve para cualquiera de ellos", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ", "WRITE"] });

    expect((await servicio().autenticar(clave, "READ")).ok).toBe(true);
    expect((await servicio().autenticar(clave, "WRITE")).ok).toBe(true);
  });

  it("una clave que no existe no autentica", async () => {
    const resultado = await servicio().autenticar(generarClave(), "READ");

    expect(resultado).toEqual({ ok: false, motivo: "NO_AUTENTICADA" });
  });

  it("el prefijo correcto con el resto de la clave cambiado no autentica", async () => {
    // El caso que separa "busca por prefijo" de "autentica por prefijo": el
    // prefijo no es secreto, asi que acertarlo no puede alcanzar.
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const impostora = prefijoDe(clave) + "0".repeat(clave.length - prefijoDe(clave).length);
    expect(impostora).not.toBe(clave);

    const resultado = await servicio().autenticar(impostora, "READ");
    expect(resultado).toEqual({ ok: false, motivo: "NO_AUTENTICADA" });
  });

  it("una clave revocada no autentica", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"], revocada: true });

    const resultado = await servicio().autenticar(clave, "READ");

    expect(resultado).toEqual({ ok: false, motivo: "NO_AUTENTICADA" });
  });

  it("una clave sin el scope pedido da SCOPE_INSUFICIENTE, no un 401 encubierto", async () => {
    // La distincion importa: 403 dice "sos vos, pero no podes"; 401 diria "no
    // se quien sos" y mandaria a reemitir una clave que esta bien.
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["WRITE"] });

    const resultado = await servicio().autenticar(clave, "READ");

    expect(resultado.ok).toBe(false);
    if (resultado.ok || resultado.motivo !== "SCOPE_INSUFICIENTE") {
      throw new Error(`Se esperaba SCOPE_INSUFICIENTE y llego ${JSON.stringify(resultado)}`);
    }
    expect(resultado.scopeRequerido).toBe("READ");
    expect(resultado.clave.scopes).toEqual(["WRITE"]);
  });

  it("una clave revocada Y sin el scope da NO_AUTENTICADA: la revocacion manda", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["WRITE"], revocada: true });

    expect(await servicio().autenticar(clave, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });
  });

  it("una clave emitida con otro pepper deja de autenticar", async () => {
    // La contraprueba de que el pepper entra de verdad en el hash. Solo se
    // puede escribir asi porque el pepper se inyecta.
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"], pepper: "pepper-viejo" });

    expect((await servicio("pepper-viejo").autenticar(clave, "READ")).ok).toBe(true);
    expect(await servicio("pepper-nuevo").autenticar(clave, "READ")).toEqual({
      ok: false,
      motivo: "NO_AUTENTICADA",
    });
  });

  it("la clave en claro no queda en la base", async () => {
    const clave = generarClave();
    await sembrarClave({ clave, scopes: ["READ"] });

    const filas = await client.query<{ fila: string }>(
      `SELECT (label || '|' || prefix || '|' || key_hash) AS fila FROM api_key`,
    );

    expect(filas.rows).toHaveLength(1);
    expect(filas.rows[0]?.fila).not.toContain(clave.slice(prefijoDe(clave).length));
  });

  it("un buscador inyectado evita la base: el servicio no depende de Prisma", async () => {
    const clave = generarClave();
    const fila: ApiKeyRow = {
      id: uuid(),
      label: "en memoria",
      prefix: prefijoDe(clave),
      keyHash: hashearClave(clave, PEPPER),
      scopes: ["READ"],
      revokedAt: null,
    };

    const servicioEnMemoria = new ApiKeyService({
      pepper: PEPPER,
      buscar: async (prefix) => (prefix === fila.prefix ? fila : null),
    });

    expect((await servicioEnMemoria.autenticar(clave, "READ")).ok).toBe(true);
  });
});

describe("ApiKeyService constructor", () => {
  it("un pepper vacio falla al construir, no en la primera peticion", () => {
    // Un pepper vacio hashea sin protestar: el fallo seria silencioso.
    expect(() => new ApiKeyService({ pepper: "" })).toThrow(/API_KEY_PEPPER/);
    expect(() => new ApiKeyService({ pepper: "   " })).toThrow(/API_KEY_PEPPER/);
  });
});
