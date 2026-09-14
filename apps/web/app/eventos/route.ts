import type { AvisoDeCambio } from "@taskman/core/cambios";

import { suscribirseACambios } from "../../lib/cambios";

/**
 * GET /eventos: el flujo de Server-Sent Events que le dice al tablero que algo
 * cambio (CT-06 y CT-07).
 *
 * --- POR QUE NO ESTA BAJO /api ----------------------------------------------
 *
 * No es un descuido de organizacion: `/api` es el contrato de la 6.2, y TODO lo
 * que hay ahi lleva `conAuth` con su scope (7.2) salvo `/api/health`. Esta ruta
 * no puede llevarlo, porque la UI no usa ninguna API key: invoca los servicios
 * en el mismo proceso y no consume su propia API publica (9.1). Meterla ahi la
 * volveria una excepcion mas dentro de la lista que CLAUDE.md manda leer con un
 * grep, y esa lista dice hoy algo simple y cierto —"todos autentican menos
 * health"— que no conviene ensuciar. Fuera de `/api` queda claro que es
 * plomeria de la pantalla y no contrato.
 *
 * QUE EXPONE, entonces, sin autenticacion: por cada escritura del sistema, el
 * tipo de actor, la accion, el tipo de entidad y su UUID. No lleva titulos, ni
 * descripciones, ni fechas, ni el contenido de nada. Es el minimo que la
 * pantalla necesita para saber a que tarjeta ponerle la marca, y no hay forma de
 * reconstruir un tablero con eso.
 *
 * Lo que eso NO hace es proteger el contenido: la UI entera no autentica. `GET /`
 * sirve los tableros con sus titulos y fechas, `?tarea=` agrega la descripcion,
 * y las Server Actions escriben y borran sin clave. Esta ruta no expone nada que
 * la pagina no exponga ya. Es una decision de sistema personal en un contenedor,
 * declarada en los desvios de CLAUDE.md ("La UI no tiene autenticacion"); el dia
 * que esto se publique, va con la misma cabecera que el resto.
 *
 * --- POR QUE SSE Y NO WEBSOCKET ---------------------------------------------
 *
 * El trafico es de una sola direccion: el servidor avisa y el navegador no
 * responde nada. `EventSource` es HTTP normal, reconecta solo y no necesita
 * libreria ni de un lado ni del otro. Un WebSocket agregaria una segunda pila de
 * protocolo para no usar la mitad de ida.
 *
 * --- UN FLUJO ABIERTO ES UNA ESCUCHA VIVA -----------------------------------
 *
 * Este flujo NO sobrevive a la escucha que lo alimenta. Si la conexion `LISTEN`
 * se cae, `lib/cambios.ts` echa a los suscriptores y el flujo se CIERRA; si al
 * abrirse no se puede escuchar, se cierra sin haber mandado `listo`. En los dos
 * casos el navegador vuelve a pedir esta ruta a los `REINTENTO_MS`, y cuando la
 * escucha vuelve, el `listo` de la reconexion hace que el tablero refresque.
 *
 * Es lo que hace que `data-cambios` pueda decir la verdad: "conectado" sale del
 * `listo`, y se apaga en cuanto el flujo se cierra. Antes el flujo seguia abierto
 * con la escucha muerta, y el tablero se creia conectado estando sordo.
 */

/**
 * `force-dynamic` y sin cache: es un flujo que no termina, y cachearlo seria
 * servir una foto del primer segundo a todo el mundo.
 */
export const dynamic = "force-dynamic";

/**
 * Cada cuanto se manda un comentario de mantenimiento (`:`).
 *
 * NO ES UN SONDEO: no toca la base, no consulta nada. Existe para que el flujo no
 * pase horas mudo: un intermediario con tiempo de inactividad —el
 * `proxy_read_timeout` de nginx es de 60 s por defecto— da por muerta una
 * conexion que no transmite nada, y un cliente que se fue sin cerrar solo se
 * descubre al intentar escribirle.
 *
 * Y NO ES UNA SEÑAL DE SALUD, que es el error que costo la sordera. Lo emite un
 * temporizador de ESTE proceso y no pasa por PostgreSQL, asi que prueba que el
 * camino navegador-servidor esta abierto y nada sobre la escucha: con el
 * `LISTEN` muerto seguia llegando puntual. Del otro lado tampoco lo vigila nadie:
 * `EventSource` no tiene temporizador de inactividad, asi que el latido dejando
 * de llegar no dispara nada en el navegador. Si el servidor desaparece, lo que
 * provoca la reconexion es el cierre del socket, no la falta de latido. La salud
 * de la escucha la da el propio flujo, que se cierra cuando ella muere.
 */
const LATIDO_MS = 30_000;

/**
 * CUANTO ESPERA `EventSource` PARA VOLVER cuando este flujo se cierra. Se le manda
 * con `retry:` antes que nada, asi vale tambien cuando el flujo se cierra sin
 * haber llegado a escuchar.
 *
 * Es lo que tarda un tablero en volver a oir despues de perder la escucha con
 * PostgreSQL arriba, y es tambien el ritmo al que cada pestaña abierta reintenta
 * mientras la base esta caida: cada intento es una conexion nueva que falla
 * rapido. Tres segundos, del orden del valor por defecto de los navegadores;
 * escribirlo saca ese numero del navegador y lo deja donde se puede leer.
 */
const REINTENTO_MS = 3_000;

function sse(evento: string, datos: unknown): string {
  return `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
}

export async function GET(peticion: Request): Promise<Response> {
  const codificador = new TextEncoder();
  /**
   * Cierra el flujo y suelta todo lo que cuelga de el. La asigna `start` en su
   * parte sincrona —antes de cualquier espera— asi que `cancel` siempre encuentra
   * la de verdad.
   */
  let cerrar: () => void = () => undefined;

  const flujo = new ReadableStream<Uint8Array>({
    async start(controlador) {
      let cerrado = false;
      let darDeBaja: (() => void) | undefined;
      let latido: ReturnType<typeof setInterval> | undefined;

      /** Una funcion y no la variable: TypeScript no ve que `cerrar` la cambia. */
      const estaCerrado = (): boolean => cerrado;

      const escribir = (texto: string): void => {
        if (cerrado) {
          return;
        }

        try {
          controlador.enqueue(codificador.encode(texto));
        } catch {
          // El cliente se fue entre el aviso y la escritura.
          cerrado = true;
        }
      };

      cerrar = (): void => {
        if (cerrado) {
          return;
        }

        cerrado = true;
        darDeBaja?.();
        darDeBaja = undefined;

        if (latido !== undefined) {
          clearInterval(latido);
          latido = undefined;
        }

        try {
          controlador.close();
        } catch {
          // Ya estaba cerrado, o lo cancelo el cliente.
        }
      };

      /**
       * El cliente se fue: cerro la pestaña, navego, o `EventSource` se
       * reconecto. Sin esto, el suscriptor se quedaria en el Set para siempre y
       * cada recarga de la pagina dejaria uno mas escribiendo en un socket
       * muerto.
       */
      peticion.signal.addEventListener("abort", cerrar);

      if (peticion.signal.aborted) {
        cerrar();

        return;
      }

      escribir(`retry: ${REINTENTO_MS}\n\n`);

      let baja: () => void;

      try {
        baja = await suscribirseACambios({
          alCambiar: (aviso: AvisoDeCambio) => escribir(sse("cambio", aviso)),
          // La escucha se cayo: se cierra, y `EventSource` vuelve a los
          // `REINTENTO_MS`. Ver la cabecera.
          alPerderLaEscucha: cerrar,
        });
      } catch {
        /**
         * SIN BASE NO HAY ESCUCHA, y el flujo se cierra igual que cuando la
         * escucha se cae: el navegador vuelve a los `REINTENTO_MS` y lo intenta de
         * nuevo, hasta que la base vuelva.
         *
         * Se CIERRA y no se ERRA (`controlador.error`): el final normal de la
         * respuesta es el camino que el protocolo de `EventSource` define para
         * reintentar, y un error a mitad de cuerpo queda en manos de como lo
         * traduzca Next.
         */
        cerrar();

        return;
      }

      // Mientras se esperaba, el cliente pudo irse o la escucha pudo caerse, y
      // en los dos casos `cerrar` ya corrio. Nada de `listo` ni de latido sobre
      // un flujo cerrado; y la baja por si el cierre llego antes que ella.
      if (estaCerrado()) {
        baja();

        return;
      }

      darDeBaja = baja;

      // Un primer evento inmediato, para que el cliente sepa que la escucha esta
      // puesta de verdad y no solo que el socket se abrio.
      escribir(sse("listo", { ok: true }));

      latido = setInterval(() => escribir(":\n\n"), LATIDO_MS);
    },

    cancel() {
      cerrar();
    },
  });

  return new Response(flujo, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Sin esto, un nginx delante con buffer no entrega nada hasta llenarlo.
      "X-Accel-Buffering": "no",
    },
  });
}
