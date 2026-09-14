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
 */

/** A quien avisar cuando llega un cambio. Devuelve `false` si ya no le interesa. */
type Suscriptor = (aviso: AvisoDeCambio) => void;

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
        suscriptor(aviso);
      } catch {
        // Un suscriptor roto no puede llevarse por delante a los demas.
      }
    }
  });

  /**
   * Una conexion caida se descarta y la siguiente suscripcion abre otra. NO se
   * reconecta sola con un temporizador: sin nadie escuchando no hay nada que
   * mantener vivo, y un reintento periodico seria justo el trafico constante que
   * este mecanismo existe para no tener.
   *
   * El agujero que deja —los cambios ocurridos mientras no habia conexion— lo
   * cierra el cliente, que refresca al reconectar el `EventSource`.
   */
  cliente.on("error", (error: unknown) => {
    estado.cliente = undefined;
    registrarFallo("listen", error);
  });

  cliente.on("end", () => {
    estado.cliente = undefined;
  });

  await cliente.connect();
  // El nombre del canal es un identificador y no admite parametro; es una
  // constante del codigo, no entrada de nadie.
  await cliente.query(`LISTEN ${CANAL_DE_CAMBIOS}`);

  estado.cliente = cliente;
}

/**
 * Se suscribe a los cambios. Devuelve la funcion para darse de baja.
 *
 * La conexion se abre con el primer suscriptor y NO se cierra con el ultimo: el
 * coste de tenerla abierta es una conexion ociosa, y cerrarla y reabrirla en
 * cada recarga de la pagina cuesta un viaje y abre una ventana en la que un
 * cambio se pierde. Una conexion ociosa no genera trafico.
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
