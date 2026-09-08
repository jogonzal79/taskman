import { hashearClave, hashesIguales, prefijoDe, type Scope } from "../domain/api-key.js";
import { buscarClavePorPrefijo, type ApiKeyRow } from "../db/api-key-repository.js";

/**
 * Verificacion de API keys (ADR-005, 7.1 y 7.2).
 *
 * La regla de "que hace valida a una clave" vive aca y no en el adaptador: es
 * negocio, no protocolo. El adaptador solo traduce el resultado a HTTP.
 */

/** Lo que el borde necesita saber de la clave que autentico. */
export interface ClaveAutenticada {
  id: string;
  /** En claro y no secreto: es lo que se registra en el log y en la auditoria. */
  prefix: string;
  label: string;
  scopes: readonly Scope[];
}

/**
 * Union discriminada y no excepciones. Que una clave no autentique es una
 * salida ESPERADA de este camino, no un fallo; y al ser union, el adaptador no
 * puede olvidarse de un caso sin que el compilador se lo diga. Los dos motivos
 * son exactamente los dos codigos de la 6.4 que cubre este paso.
 */
export type ResultadoAutenticacion =
  | { readonly ok: true; readonly clave: ClaveAutenticada }
  | { readonly ok: false; readonly motivo: "NO_AUTENTICADA" }
  | {
      readonly ok: false;
      readonly motivo: "SCOPE_INSUFICIENTE";
      readonly clave: ClaveAutenticada;
      readonly scopeRequerido: Scope;
    };

export type BuscadorDeClaves = (prefix: string) => Promise<ApiKeyRow | null>;

export interface OpcionesApiKeyService {
  /**
   * 7.1. Llega INYECTADO: el nucleo no lee process.env (3.2). Ademas de la
   * regla de capas, es lo que permite probar el servicio con un pepper de
   * prueba sin tocar el entorno del proceso.
   */
  pepper: string;
  /** Inyectable para las pruebas; por defecto va contra la base. */
  buscar?: BuscadorDeClaves;
}

export class ApiKeyService {
  readonly #pepper: string;
  readonly #buscar: BuscadorDeClaves;

  constructor(opciones: OpcionesApiKeyService) {
    // Falla al construir y no en la primera peticion. Un pepper vacio hashea
    // sin protestar y produce claves que "funcionan" pero cuyo hash no depende
    // de ningun secreto: el fallo seria silencioso y del peor tipo.
    if (opciones.pepper.trim() === "") {
      throw new Error("API_KEY_PEPPER no puede estar vacio: sin pepper el hash no protege nada.");
    }

    this.#pepper = opciones.pepper;
    this.#buscar = opciones.buscar ?? ((prefix) => buscarClavePorPrefijo(prefix));
  }

  /**
   * Autentica una clave en claro y comprueba el scope de la 7.2 en un solo
   * paso, porque son la misma decision: "esta peticion puede hacer esto".
   *
   * Los tres caminos que terminan en NO_AUTENTICADA —clave inexistente, hash
   * que no coincide, clave revocada— devuelven lo MISMO a proposito (6.4: el
   * 401 cubre los tres). Distinguirlos en la respuesta le diria a quien prueba
   * claves cual de sus intentos existe.
   */
  async autenticar(claveEnClaro: string, scopeRequerido: Scope): Promise<ResultadoAutenticacion> {
    const fila = await this.#buscar(prefijoDe(claveEnClaro));

    if (fila === null) {
      return { ok: false, motivo: "NO_AUTENTICADA" };
    }

    if (!hashesIguales(hashearClave(claveEnClaro, this.#pepper), fila.keyHash)) {
      return { ok: false, motivo: "NO_AUTENTICADA" };
    }

    // Se comprueba DESPUES del hash y no antes: revocada o no, una clave que no
    // es la que dice ser no tiene por que enterarse de que el prefijo existia.
    if (fila.revokedAt !== null) {
      return { ok: false, motivo: "NO_AUTENTICADA" };
    }

    const clave: ClaveAutenticada = {
      id: fila.id,
      prefix: fila.prefix,
      label: fila.label,
      scopes: fila.scopes,
    };

    if (!fila.scopes.includes(scopeRequerido)) {
      return { ok: false, motivo: "SCOPE_INSUFICIENTE", clave, scopeRequerido };
    }

    return { ok: true, clave };
  }
}
