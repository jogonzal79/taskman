import { CANAL_DE_CAMBIOS, leerAvisoDeCambio, type AvisoDeCambio } from "@taskman/core/cambios";
import { Client } from "pg";

import { registrarFallo } from "./log";

/**
 * EL LADO QUE ESCUCHA: una sola conexion `LISTEN` por proceso, y un reparto en
 * memoria a todas las pestañas conectadas.
 *
 * --- POR QUE LISTEN/NOTIFY Y NO UN SONDEO ------------------------------------
 *
 * El criterio era que un sondeo constante contra PostgreSQL importa aunque la
 * carga no. Un sondeo, por barato que sea cada consulta, es trafico CONSTANTE:
 * con la pantalla abierta y nadie tocando nada, la base sigue recibiendo una
 * consulta cada N segundos, para siempre. Esto no: hay UNA sentencia `LISTEN`
 * al arrancar y despues cero. Si nadie escribe, no se ejecuta ni una consulta.
 * Medido; ver el informe del paso.
 *
 * --- POR QUE NO UN EMISOR EN MEMORIA ----------------------------------------
 *
 * Seria mas simple: las escrituras pasan por el nucleo, asi que un
 * `EventEmitter` en el proceso las veria todas... las de ESTE proceso.
 * `apps/mcp-stdio` es OTRO proceso —`node dist/index.js`, arrancado por el
 * cliente MCP— y escribe en la misma base sin pasar por el servidor web. Un
 * emisor en memoria no ve nada de eso, o sea que CT-07 (mover por MCP y verlo
 * en la UI) no se cumpliria justo en el caso que le da sentido al paso.
 * PostgreSQL es el unico sitio por el que pasan los dos procesos.
 *
 * --- POR QUE NO PRISMA -------------------------------------------------------
 *
 * `LISTEN` no es una consulta: la notificacion llega despues, de forma asincrona
 * y sin que nadie pregunte. Eso es una capacidad del protocolo que Prisma no
 * expone, asi que hace falta un cliente `pg` crudo. Es ademas la razon de que
 * sea una conexion APARTE y no del pool: una conexion que escucha no se puede
 * devolver al pool, porque el `LISTEN` se registra sobre la sesion.
 *
 * --- EL CICLO DE VIDA --------------------------------------------------------
 *
 * Se crea EN EL PRIMER SUSCRIPTOR, no al importar el modulo. Es la misma trampa
 * que ya pagaron el proxy de `packages/db`, el logger y el `ApiKeyService`: el
 * "Collecting page data" de `next build` importa cada Route Handler sin
 * ejecutar nada, y abrir una conexion al importar rompe el build.
 *
 * Cuelga de `globalThis` por lo mismo que el logger y el registro del limite de
 * peticiones: Next arma un grafo por ruta y una variable de modulo puede acabar
 * siendo una por endpoint. Aca eso serian N conexiones escuchando lo mismo.
 *
 * --- SI LA ESCUCHA SE CAE ----------------------------------------------------
 *
 * UNA SUSCRIPCION DURA LO QUE DURA LA CONEXION QUE LA ATIENDE. Cuando PostgreSQL
 * corta el `LISTEN` —se reinicio, o alguien mato la conexion— se echa a TODOS
 * los suscriptores y cada uno cierra su flujo (`alPerderLaEscucha`).
 *
 * Antes no se los echaba, y ese era el fallo: el cliente quedaba en `undefined`,
 * los flujos SSE seguian abiertos con su latido, `EventSource` no veia ningun
 * error, y el tablero quedaba SORDO diciendo "conectado". Medido: tras
 * `pg_terminate_backend`, una escritura no llegaba nunca y los latidos seguian.
 * Tampoco alcanzaria con dejarlos esperando a la conexion siguiente: `NOTIFY` no
 * guarda nada, asi que lo escrito entre medio se perdio, y un suscriptor que
 * volviera a oir por la conexion nueva no tendria forma de saber que se perdio
 * algo.
 *
 * CERRAR EL FLUJO ES LO QUE PONE EN MARCHA LA RECUPERACION, y con piezas que ya
 * existian: `EventSource` reintenta solo, el reintento vuelve a suscribirse y
 * eso reabre la escucha, y el `listo` de esa reconexion hace que el tablero
 * refresque una vez (`alReconectar` en `usar-cambios.ts`). Lo perdido lo trae el
 * refresco, no un aviso.
 *
 * DESCARTADO un evento de estado ("sordo") con el flujo abierto. Obligaria a un
 * temporizador de reconexion en el servidor, y a sostener dos nociones de
 * "conectado" —la del socket y la de la escucha— que el cliente tendria que
 * cruzar. Cerrando, son la misma: un flujo abierto es una escucha viva.
 *
 * NO HAY TEMPORIZADOR DE RECONEXION. Reintentan las pestañas abiertas, una vez
 * cada `REINTENTO_MS` de `/eventos`, y solo mientras la escucha falte: sin
 * pestañas no se intenta nada, y con la escucha sana el trafico sigue en cero.
 */

/** Quien escucha: que hacer con cada aviso, y que hacer cuando la escucha se pierde. */
export interface Suscriptor {
  /** Llego un cambio, propio o ajeno. */
  alCambiar: (aviso: AvisoDeCambio) => void;
  /**
   * LA CONEXION `LISTEN` SE CAYO Y ESTA SUSCRIPCION TERMINO: ya no esta en la
   * lista y no recibe nada mas, tampoco cuando otra pestaña reabra la escucha.
   * Quien la recibe tiene que cerrar su flujo, que es la unica forma de que el
   * navegador se entere (ver la cabecera).
   */
  alPerderLaEscucha: () => void;
}

interface Escucha {
  cliente: Client | undefined;
  suscriptores: Set<Suscriptor>;
  /** La conexion en curso, para que dos suscriptores a la vez no abran dos. */
  conectando: Promise<void> | undefined;
}

const global = globalThis as typeof globalThis & { __taskmanEscucha?: Escucha };

function escucha(): Escucha {
  global.__taskmanEscucha ??= {
    cliente: undefined,
    suscriptores: new Set(),
    conectando: undefined,
  };

  return global.__taskmanEscucha;
}

/**
 * Abre la conexion y se pone a escuchar. Idempotente: varias pestañas abriendo a
 * la vez comparten la MISMA promesa de conexion, que es lo que impide que la
 * primera rafaga de suscriptores abra una conexion cada uno.
 */
async function asegurarEscucha(estado: Escucha): Promise<void> {
  if (estado.cliente !== undefined) {
    return;
  }

  estado.conectando ??= conectar(estado).finally(() => {
    estado.conectando = undefined;
  });

  await estado.conectando;
}

async function conectar(estado: Escucha): Promise<void> {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL no esta definida.");
  }

  const cliente = new Client({ connectionString: url });

  cliente.on("notification", (mensaje) => {
    const aviso = leerAvisoDeCambio(mensaje.payload);

    // Un mensaje que no tiene la forma esperada se descarta en silencio: puede
    // venir de otra version del proceso o de alguien probando con psql, y esto
    // es un bucle de larga vida que no se puede tumbar por eso.
    if (aviso === undefined) {
      return;
    }

    for (const suscriptor of estado.suscriptores) {
      try {
        suscriptor.alCambiar(aviso);
      } catch {
        // Un suscriptor roto no puede llevarse por delante a los demas.
      }
    }
  });

  /**
   * LA CAIDA SE ATIENDE EN LOS DOS EVENTOS, `error` y `end`: segun como muera la
   * conexion, `pg` emite uno, el otro o los dos, y mas de una vez (el corte
   * medido con `pg_terminate_backend` emitio dos `error` seguidos).
   * `perderLaEscucha` hace que cuente una sola vez.
   *
   * NO SE RECONECTA DESDE ACA: se echa a los suscriptores, sus flujos se cierran,
   * y la conexion nueva la abre el primero que vuelva. Ver la cabecera.
   */
  cliente.on("error", (error: unknown) => {
    registrarFallo("listen", error);
    perderLaEscucha(estado, cliente);
  });

  cliente.on("end", () => {
    perderLaEscucha(estado, cliente);
  });

  try {
    await cliente.connect();
    // El nombre del canal es un identificador y no admite parametro; es una
    // constante del codigo, no entrada de nadie.
    await cliente.query(`LISTEN ${CANAL_DE_CAMBIOS}`);
  } catch (error: unknown) {
    // No llego a escuchar. Se suelta lo que se haya abierto —si fallo el
    // `LISTEN` y no la conexion, esta quedaria ociosa y sin dueño— y el fallo
    // sube a quien se estaba suscribiendo, que cierra su flujo.
    void cliente.end().catch(() => undefined);

    throw error;
  }

  estado.cliente = cliente;
}

/**
 * LA ESCUCHA SE PERDIO: se descarta el cliente y se echa a todos los
 * suscriptores, avisandole a cada uno.
 *
 * SOLO CUENTA LA CAIDA DEL CLIENTE VIGENTE. Los eventos de una misma caida
 * llegan en tics distintos, y en medio puede entrar una pestaña que reabre la
 * escucha con un cliente nuevo: sin esta comparacion, el `end` tardio del viejo
 * echaria a los suscriptores del nuevo y dejaria esa conexion abierta y sin
 * nadie que la use. La misma comparacion hace que la segunda senal de una caida
 * no haga nada, y que un cliente que nunca llego a escuchar tampoco.
 *
 * Se vacia la lista ANTES de avisar: si un aviso volviera a suscribir en el
 * acto, no tiene que ser echado por la caida anterior.
 */
function perderLaEscucha(estado: Escucha, cliente: Client): void {
  if (estado.cliente !== cliente) {
    return;
  }

  estado.cliente = undefined;

  const echados = [...estado.suscriptores];
  estado.suscriptores.clear();

  for (const suscriptor of echados) {
    try {
      suscriptor.alPerderLaEscucha();
    } catch {
      // Un suscriptor roto no puede dejar a los demas sin enterarse.
    }
  }
}

/**
 * Se suscribe a los cambios. Devuelve la funcion para darse de baja.
 *
 * La conexion se abre con el primer suscriptor y NO se cierra con el ultimo: el
 * coste de tenerla abierta es una conexion ociosa, y cerrarla y reabrirla en
 * cada recarga de la pagina cuesta un viaje y abre una ventana en la que un
 * cambio se pierde. Una conexion ociosa no genera trafico.
 *
 * Si la escucha se cae despues, avisa `alPerderLaEscucha` y la suscripcion queda
 * anulada; la funcion de baja se puede seguir llamando, y no hace nada.
 */
export async function suscribirseACambios(suscriptor: Suscriptor): Promise<() => void> {
  const estado = escucha();

  estado.suscriptores.add(suscriptor);

  try {
    await asegurarEscucha(estado);
  } catch (error: unknown) {
    estado.suscriptores.delete(suscriptor);

    throw error;
  }

  return () => {
    estado.suscriptores.delete(suscriptor);
  };
}
