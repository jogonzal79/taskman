import type { ScopeHttp } from "./auth.js";

/**
 * Limite de peticiones por clave de la 7.3: 120 por minuto para lectura y 30
 * por minuto para escritura, con ventana deslizante en memoria.
 *
 * EN MEMORIA quiere decir lo que dice, y es una limitacion real y no un detalle:
 * el estado muere con el proceso —un reinicio le devuelve el cupo entero a todo
 * el mundo— y se duplica por instancia —dos replicas dan el doble de cupo, cada
 * una contando la mitad de las peticiones—. Para el sistema personal de un solo
 * contenedor que describe la 11.3 es exactamente lo que pide la 7.3, y la salida
 * el dia que deje de serlo es un contador compartido (Redis o la base), no mas
 * memoria.
 *
 * Vive en el adaptador y no en el nucleo porque no es una regla de negocio: es
 * una medida del borde HTTP, en la misma lista de la 7.3 que el limite de cuerpo
 * y el CORS. El nucleo no sabe que existen las peticiones.
 */

export type Cubo = "lectura" | "escritura";

/**
 * QUE CUENTA COMO ESCRITURA: lo decide el SCOPE que exige el endpoint, no su
 * metodo HTTP.
 *
 * Los dos limites de la 7.3 se llaman "lectura" y "escritura", y esas dos
 * palabras ya estan definidas en la 7.2, que es la que reparte los verbos entre
 * los scopes: `read` es GET, `write` es POST y PATCH incluido move, y `delete`
 * es DELETE. O sea que el scope ES la particion que la 7.3 nombra, y no hace
 * falta inventar una segunda.
 *
 * Mirar el metodo seria justamente inventarla, con dos consecuencias: habria dos
 * clasificaciones de "esto escribe" libres de discrepar —el dia que exista un
 * POST que solo lee, una busqueda con cuerpo por ejemplo, el metodo lo contaria
 * como escritura y el scope como lectura— y la clasificacion nueva no estaria
 * declarada en ningun sitio, mientras el scope es un argumento OBLIGATORIO de
 * `conAuth` en cada ruta.
 *
 * `delete` cae en escritura: la 7.3 nombra dos cupos y la 7.2 tres scopes, asi
 * que alguno comparte, y un DELETE no es una lectura. Le toca ademas el cupo
 * MAS ESTRECHO, que es donde conviene que caiga la clase mas destructiva.
 *
 * El `Record` es exhaustivo a proposito: un scope nuevo no compila hasta que
 * alguien decida en que cupo cae. La alternativa —un `??` con un valor por
 * defecto— lo metaria en uno de los dos sin que nadie lo decida.
 */
export const CUBO_POR_SCOPE: Record<ScopeHttp, Cubo> = {
  read: "lectura",
  write: "escritura",
  delete: "escritura",
};

/** 7.3, por clave y por minuto. */
export const LIMITE_POR_CUBO: Record<Cubo, number> = {
  lectura: 120,
  escritura: 30,
};

export const VENTANA_MS = 60_000;

/** Como se llama cada cupo en el cuerpo del 429, que va en ingles (6.1). */
const NOMBRE_HTTP: Record<Cubo, string> = {
  lectura: "read",
  escritura: "write",
};

export interface LimiteSuperado {
  readonly permitido: false;
  readonly cubo: Cubo;
  readonly nombreHttp: string;
  readonly limite: number;
  /** Segundos enteros, nunca cero: es el valor de `Retry-After`. */
  readonly esperaSegundos: number;
}

export type Veredicto = { readonly permitido: true } | LimiteSuperado;

/**
 * El registro de marcas de tiempo, una lista por (clave, cupo).
 *
 * Colgado de `globalThis` y no de una variable de modulo por lo mismo que el
 * cliente de Prisma: no hay garantia de que el modulo se evalue UNA sola vez en
 * el proceso. Next arma un grafo por ruta y el hot reload de dev lo reconstruye,
 * asi que una variable de modulo podria terminar siendo una por ruta, y el
 * limite de la 7.3 —que es por clave y no por endpoint— se multiplicaria por la
 * cantidad de endpoints sin que nada lo delate. Anclarlo al proceso hace que la
 * pregunta no haya que contestarla.
 *
 * TAMAÑO: una entrada por (clave, cupo) que haya pedido algo en este proceso, y
 * como mucho 120 numeros dentro. Las entradas de una clave que dejo de pedir no
 * se borran, solo se podan al volver a tocarlas; con las pocas claves de un uso
 * personal eso no se nota, y el dia que se note el arreglo es el mismo contador
 * compartido que arregla lo demas.
 */
const globalParaLimite = globalThis as typeof globalThis & {
  __taskmanLimiteDePeticiones?: Map<string, number[]>;
};

function almacen(): Map<string, number[]> {
  globalParaLimite.__taskmanLimiteDePeticiones ??= new Map();

  return globalParaLimite.__taskmanLimiteDePeticiones;
}

/**
 * El interruptor de la 11.2, leido POR PETICION y no al evaluar el modulo.
 *
 * Leerlo al importar es la trampa que ya pago este paquete dos veces: el
 * `ApiKeyService` se construye por peticion porque leer el pepper al importar
 * rompe el "Collecting page data" de `next build`. Una lectura de `process.env`
 * por peticion no se mide al lado de la consulta que autentica la clave.
 *
 * FALLA CERRADO: solo el texto "false" apaga el limite. Ausente lo deja
 * ENCENDIDO —un despliegue que se olvide la variable queda protegido— y un valor
 * mal escrito tambien, ademas de impedir el arranque por la comprobacion de
 * `instrumentation.ts`.
 */
function habilitado(): boolean {
  return process.env["RATE_LIMIT_ENABLED"]?.trim().toLowerCase() !== "false";
}

/**
 * Cobra una peticion al cupo de una clave y dice si pasa.
 *
 * VENTANA DESLIZANTE Y NO FIJA: se guarda la marca de cada peticion y se
 * descartan las que ya cumplieron el minuto, asi que el cupo se recupera de a
 * poco —cada marca libera su lugar al minuto de haberse hecho— y no de golpe al
 * cambiar de minuto. Con ventana fija, 30 escrituras a las 12:00:59 y otras 30 a
 * las 12:01:00 pasarian las dos rafagas: 60 escrituras en dos segundos.
 *
 * `ahora` se inyecta SOLO para poder probar el deslizamiento sin esperar un
 * minuto de reloj. El llamador de produccion lo omite.
 */
export function consumir(claveId: string, cubo: Cubo, ahora: number = Date.now()): Veredicto {
  if (!habilitado()) {
    return { permitido: true };
  }

  const limite = LIMITE_POR_CUBO[cubo];
  const registro = almacen();
  const indice = `${claveId}:${cubo}`;
  const desde = ahora - VENTANA_MS;
  const marcas = (registro.get(indice) ?? []).filter((marca) => marca > desde);

  if (marcas.length >= limite) {
    // La mas vieja es la primera en liberarse, y es la que va en Retry-After.
    // `marcas[0]` existe: la lista tiene al menos `limite` elementos y el limite
    // de los dos cupos es mayor que cero.
    const masVieja = marcas[0] ?? ahora;
    const esperaMs = masVieja + VENTANA_MS - ahora;

    // Se guarda la lista PODADA aunque la peticion se rechace: la poda es
    // trabajo ya hecho, y no cobrar la peticion rechazada es deliberado —un
    // cliente en bucle no se castiga con una espera que crece sola, porque la
    // 7.3 pide un limite, no un destierro.
    registro.set(indice, marcas);

    return {
      permitido: false,
      cubo,
      nombreHttp: NOMBRE_HTTP[cubo],
      limite,
      // Hacia arriba y nunca cero: un Retry-After de 0 invita a un reintento
      // inmediato que vuelve a fallar.
      esperaSegundos: Math.max(1, Math.ceil(esperaMs / 1000)),
    };
  }

  marcas.push(ahora);
  registro.set(indice, marcas);

  return { permitido: true };
}

/**
 * Vacia el registro. Lo usa la suite entre pruebas: el estado esta anclado al
 * proceso, asi que sin esto una prueba heredaria el cupo gastado por la anterior.
 *
 * Vacia el Map en vez de reemplazarlo para no dejar colgada una referencia vieja
 * en otra instancia del modulo, que es justo lo que el ancla global evita.
 */
export function reiniciarLimiteDePeticiones(): void {
  almacen().clear();
}
