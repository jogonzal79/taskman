import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Primitivas de las API keys (ADR-005 y 7.1).
 *
 * Este modulo NO importa nada del resto del nucleo a proposito: solo
 * `node:crypto`. De eso depende que el script de administracion lo pueda
 * importar por ruta directa sin empaquetar el arbol entero (ver
 * scripts/create-api-key.mjs). Si algun dia necesita un import interno, el
 * script pasa a necesitar un bundle.
 *
 * Que el script y el verificador compartan ESTAS funciones no es comodidad: si
 * cada uno calculara el hash por su cuenta, una diferencia entre los dos
 * produciria claves recien emitidas que no validan, y el sintoma seria un 401
 * indistinguible de una clave mal tipeada.
 */

/** Scopes de la 7.2. En mayuscula, como el enum `Scope` de la base. */
export const SCOPES = ["READ", "WRITE", "DELETE"] as const;

export type Scope = (typeof SCOPES)[number];

export function esScope(valor: unknown): valor is Scope {
  return typeof valor === "string" && (SCOPES as readonly string[]).includes(valor);
}

/** 7.1: el formato es `tmk_live_` seguido del material aleatorio. */
export const PREFIJO_CLAVE = "tmk_live_";

/** 7.1: el prefijo visible son `tmk_live_` mas los primeros 6 caracteres. */
export const LARGO_PREFIJO_VISIBLE = 6;

const ALFABETO_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const BYTES_ALEATORIOS = 32;

/**
 * 62^43 > 2^256 > 62^42, asi que 43 caracteres es el ancho exacto que necesitan
 * 32 bytes. Se rellena a la izquierda para que TODAS las claves midan lo mismo:
 * codificar un entero deja caer los ceros de la izquierda, y una clave mas
 * corta que otra filtraria que empezaba con bytes en cero.
 */
const LARGO_ALEATORIO = 43;

function aBase62(bytes: Buffer): string {
  let n = 0n;
  for (const byte of bytes) {
    n = (n << 8n) | BigInt(byte);
  }

  let texto = "";
  while (n > 0n) {
    // charAt y no [] : con noUncheckedIndexedAccess el indexado da
    // `string | undefined` aunque el resto sea imposible por construccion.
    texto = ALFABETO_BASE62.charAt(Number(n % 62n)) + texto;
    n /= 62n;
  }

  return texto.padStart(LARGO_ALEATORIO, "0");
}

/**
 * 7.1: 32 bytes aleatorios criptograficos en base62. `randomBytes` es el CSPRNG
 * del sistema; `Math.random` no serviria y no es un detalle de estilo.
 *
 * La conversion es del entero completo, no byte a byte: tomar `byte % 62` por
 * separado sesgaria la distribucion, porque 256 no es multiplo de 62.
 */
export function generarClave(): string {
  return PREFIJO_CLAVE + aBase62(randomBytes(BYTES_ALEATORIOS));
}

/**
 * El prefijo visible de una clave. Se guarda EN CLARO (7.1) para poder
 * identificarla en el log y en la auditoria sin conocerla, y es ademas por
 * donde se la busca: no es secreto, asi que buscar por el no filtra nada.
 */
export function prefijoDe(clave: string): string {
  return clave.slice(0, PREFIJO_CLAVE.length + LARGO_PREFIJO_VISIBLE);
}

/**
 * 7.1: SHA-256 de la clave concatenada con el pepper. El pepper NO se guarda en
 * la base, asi que quien se lleve un volcado de `api_key` no puede recomputar
 * los hashes ni probar candidatos sin tenerlo tambien.
 *
 * El pepper llega por parametro y no de process.env: el nucleo recibe datos ya
 * validados (3.2), y asi esta funcion se prueba sin variables de entorno.
 */
export function hashearClave(clave: string, pepper: string): string {
  return createHash("sha256").update(`${clave}${pepper}`).digest("hex");
}

/**
 * Comparacion en tiempo constante (7.1). `timingSafeEqual` exige buffers del
 * mismo largo y lanza si no lo son, de ahi la guarda previa: el largo de un
 * SHA-256 en hex es siempre 64 y no es secreto, asi que compararlo antes no
 * filtra nada que un atacante no sepa ya.
 */
export function hashesIguales(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");

  if (ba.length !== bb.length) {
    return false;
  }

  return timingSafeEqual(ba, bb);
}
