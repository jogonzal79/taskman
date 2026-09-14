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
 * reconstruir un tablero con eso: para leer cualquier dato sigue haciendo falta
 * la clave. Que la ruta no autentique es, aun asi, una decision de sistema
 * personal en un contenedor; el dia que esto se publique, va con la misma
 * cabecera que el resto.
 *
 * --- POR QUE SSE Y NO WEBSOCKET ---------------------------------------------
 *
 * El trafico es de una sola direccion: el servidor avisa y el navegador no
 * responde nada. `EventSource` es HTTP normal, reconecta solo y no necesita
 * libreria ni de un lado ni del otro. Un WebSocket agregaria una segunda pila de
 * protocolo para no usar la mitad de ida.
 */

/**
 * `force-dynamic` y sin cache: es un flujo que no termina, y cachearlo seria
 * servir una foto del primer segundo a todo el mundo.
 */
export const dynamic = "force-dynamic";

/**
 * Cada cuanto se manda un comentario de mantenimiento.
 *
 * NO ES UN SONDEO: no toca la base, no consulta nada. Son dos puntos y coma en
 * el socket, y sirven para dos cosas que un flujo silencioso no puede: que un
 * intermediario no de la conexion por muerta, y que el navegador se entere de
 * que se corto —si el servidor desaparece, el latido deja de llegar y
 * `EventSource` reconecta—.
 */
const LATIDO_MS = 30_000;

function sse(evento: string, datos: unknown): string {
  return `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
}

export async function GET(peticion: Request): Promise<Response> {
  const codificador = new TextEncoder();
  let darDeBaja: (() => void) | undefined;
  let latido: ReturnType<typeof setInterval> | undefined;

  const flujo = new ReadableStream<Uint8Array>({
    async start(controlador) {
      let cerrado = false;

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

      const cerrar = (): void => {
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
          // Ya estaba cerrado.
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

      try {
        darDeBaja = await suscribirseACambios((aviso: AvisoDeCambio) => {
          escribir(sse("cambio", aviso));
        });
      } catch (error: unknown) {
        // Sin base no hay avisos. Se cierra el flujo en vez de dejarlo abierto
        // sin escuchar nada: `EventSource` reintenta, y cuando la base vuelva la
        // suscripcion se abre en el reintento.
        controlador.error(error);

        return;
      }

      // Un primer evento inmediato, para que el cliente sepa que esta conectado
      // de verdad y no solo que el socket se abrio.
      escribir(sse("listo", { ok: true }));

      latido = setInterval(() => escribir(":\n\n"), LATIDO_MS);
    },

    cancel() {
      darDeBaja?.();
      darDeBaja = undefined;

      if (latido !== undefined) {
        clearInterval(latido);
        latido = undefined;
      }
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
