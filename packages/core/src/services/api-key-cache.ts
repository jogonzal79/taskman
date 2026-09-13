import type { ApiKeyRow } from "../db/api-key-repository.js";
import type { BuscadorDeClaves } from "./api-key-service.js";

/**
 * El cache de verificacion de la 7.1: "El resultado se cachea en memoria durante
 * 60 segundos para no consultar la base de datos en cada peticion".
 *
 * QUE SE CACHEA: la FILA de `api_key`, indexada por su prefijo. No el veredicto
 * ("esta clave es valida"), y la diferencia es de seguridad y no de estilo:
 *
 *   - La comparacion de hashes sigue corriendo en CADA peticion, en tiempo
 *     constante y contra el secreto real (7.1). El cache no puede convertir una
 *     clave equivocada en una autenticada, porque no guarda ninguna decision:
 *     guarda el dato con el que la decision se vuelve a tomar. Lo unico que se
 *     saltea es la consulta, que es exactamente lo que la 7.1 pide saltear.
 *   - La clave del mapa es el PREFIJO, que no es secreto —la 7.1 lo guarda en
 *     claro justamente para identificar la clave en el log—. Un cache indexado
 *     por la clave en claro tendria el secreto como clave de un Map y haria la
 *     busqueda por comparacion de texto, o sea justo lo que la verificacion en
 *     tiempo constante evita.
 *   - Y deja intacta la prueba que demuestra que el pepper entra en el hash: la
 *     misma fila con dos peppers distintos sigue dando resultados distintos.
 *
 * LOS FALLOS NO SE CACHEAN, y es una decision con un costo que hay que tener a la
 * vista. Un prefijo que no existe se consulta CADA vez: mil peticiones con la
 * misma clave invalida son mil consultas. No las acota el limite de la 7.3, que
 * se cobra por clave DESPUES de autenticar, asi que el trafico no autenticado
 * queda fuera; acotarlo seria un limite por IP, que la 7.3 no pide.
 *
 * Aun asi no se cachean, por el otro lado de la moneda: un negativo cacheado
 * haria que una clave RECIEN EMITIDA no autenticara hasta 60 s despues, y
 * `apikey:create` te acaba de decir que la uses. Eso se lee como "el script esta
 * roto", mientras el coste de no cachear el negativo lo paga solo quien tiene una
 * clave mal configurada. Ademas no defiende del caso que importa: quien prueba
 * prefijos al azar usa uno distinto cada vez y ningun cache de negativos lo toca.
 */

export const VENTANA_CACHE_MS = 60_000;

interface Entrada {
  readonly fila: ApiKeyRow;
  /** Marca de tiempo a partir de la cual la entrada deja de servir. */
  readonly vence: number;
}

/**
 * El estado va colgado de `globalThis` y NO en una variable de modulo ni en el
 * servicio.
 *
 * En el servicio seria inutil: `ApiKeyService` se construye POR PETICION en
 * `apps/web/lib/auth.ts` —tiene que ser asi, porque leer el pepper al evaluar el
 * modulo rompe el "Collecting page data" de `next build`— asi que un cache de
 * instancia moriria con la peticion que lo lleno y no cachearia nada. Lo que
 * sobrevive es el closure, no el mapa: `conCache` se compone por peticion y el
 * mapa es del proceso.
 *
 * Y en `globalThis` y no en una variable de modulo por lo mismo que el registro
 * del limite de peticiones: Next arma un grafo por ruta, asi que una variable de
 * modulo puede terminar siendo UNA POR ENDPOINT. Eso no rompe nada visible —solo
 * falla el cache la primera vez en cada ruta— y es la peor forma de fallar,
 * porque el ahorro que la 7.1 pide se pierde en silencio y cualquier medicion
 * empieza a depender de por que endpoint entro la peticion.
 *
 * TAMAÑO: una entrada por prefijo visto en los ultimos 60 s. En uso personal son
 * las pocas claves emitidas; las entradas vencidas se borran al volver a
 * tocarlas.
 */
const globalParaCache = globalThis as typeof globalThis & {
  __taskmanCacheDeClaves?: Map<string, Entrada>;
};

function almacen(): Map<string, Entrada> {
  globalParaCache.__taskmanCacheDeClaves ??= new Map();

  return globalParaCache.__taskmanCacheDeClaves;
}

/**
 * Envuelve un `BuscadorDeClaves` con el cache. Es un decorador y no un cambio en
 * el servicio: el servicio sigue haciendo lo mismo, y quien quiera medir sin
 * cache —o probar sin el— inyecta el buscador crudo.
 *
 * `reloj` se inyecta SOLO para poder probar el vencimiento sin esperar un minuto.
 * El llamador de produccion lo omite.
 */
export function conCache(buscar: BuscadorDeClaves, reloj: () => number = Date.now): BuscadorDeClaves {
  return async (prefix: string): Promise<ApiKeyRow | null> => {
    const registro = almacen();
    const ahora = reloj();
    const entrada = registro.get(prefix);

    if (entrada !== undefined && entrada.vence > ahora) {
      return entrada.fila;
    }

    const fila = await buscar(prefix);

    if (fila === null) {
      // Nada que cachear, y de paso se limpia la entrada vencida que acabamos de
      // descartar: asi el mapa no acumula prefijos que ya no existen.
      registro.delete(prefix);

      return null;
    }

    registro.set(prefix, { fila, vence: ahora + VENTANA_CACHE_MS });

    return fila;
  };
}

/**
 * Vacia el cache. Lo usan las suites entre pruebas —el estado esta anclado al
 * proceso, asi que sin esto una prueba heredaria las claves de la anterior— y es
 * tambien el gancho que necesitaria un camino de revocacion para cerrar la
 * ventana de 60 s (ver el comentario de `conCache` y la nota de CLAUDE.md).
 */
export function reiniciarCacheDeClaves(): void {
  almacen().clear();
}
