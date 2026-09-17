import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { GET as listarTableros, POST as crearTablero } from "../app/api/boards/route";
import { GET as obtenerTablero } from "../app/api/boards/[id]/route";
import { POST as crearColumna } from "../app/api/boards/[id]/columns/route";
import { GET as listarTareas, POST as crearTarea } from "../app/api/tasks/route";
import { GET as buscarTareas } from "../app/api/tasks/search/route";
import {
  DELETE as borrarTarea,
  GET as obtenerTarea,
  PATCH as actualizarTarea,
} from "../app/api/tasks/[id]/route";
import { POST as moverTarea } from "../app/api/tasks/[id]/move/route";

/**
 * UN SERVIDOR HTTP DE VERDAD sobre los Route Handlers de /api, para la suite de
 * `HttpPort`.
 *
 * El resto de esta suite invoca los handlers con un `Request` construido a mano,
 * y para lo que mide —el contrato de cada endpoint— alcanza. Aca no alcanza: lo
 * que hay que ejercitar es un CLIENTE HTTP, y un cliente que nunca toca un socket
 * no prueba lo suyo. Con un servidor real entran en la medicion el `fetch` de
 * verdad, la cabecera `Authorization` recorriendo la red, el query string tal
 * como se serializa, el 204 sin cuerpo —que es el unico caso donde `Response` y
 * `ServerResponse` se comportan distinto— y el `X-Request-Id` leido de cabeceras
 * reales, que es de donde `HttpPort` saca el id del servidor (O4).
 *
 * NO es Next. Es Next lo que falta: el enrutado y el ciclo de vida del framework.
 * Eso se mide aparte —`humo:dev` levanta `next dev` y la suite de extremo a
 * extremo `next start`— y lo que se prueba aca no depende de ello: los handlers
 * son funciones de `Request` a `Response`, y el enrutado de esta tabla es el
 * mismo que el de los directorios de `app/api`.
 *
 * LA TABLA CUBRE SOLO LO QUE USA `HttpPort`, que es lo que el `TaskManagerPort`
 * necesita: nueve operaciones. Los endpoints que ningun puerto invoca —el PATCH y
 * el DELETE de tablero, los de columna, la auditoria, health— no estan, y
 * agregarlos seria mantener un enrutador para nadie. Si `HttpPort` crece, crece
 * esta tabla y el typecheck no lo va a avisar: lo va a avisar el 404 del test.
 */

/** En Next 16 los parametros de una ruta dinamica llegan como Promise. */
type Contexto = { params: Promise<{ id: string }> };

type Handler = (request: Request, contexto: Contexto) => Promise<Response>;

interface Ruta {
  readonly metodo: string;
  /** Segmentos; `:id` captura. */
  readonly patron: readonly string[];
  readonly handler: Handler;
}

function ruta(metodo: string, camino: string, handler: Handler): Ruta {
  return { metodo, patron: camino.split("/").filter((parte) => parte !== ""), handler };
}

/**
 * El orden importa en un solo punto y es el mismo que resuelve Next: el segmento
 * LITERAL `search` va antes que el dinamico `:id`, asi que /api/tasks/search
 * nunca llega al handler que espera un UUID.
 */
const RUTAS: readonly Ruta[] = [
  ruta("GET", "/api/boards", listarTableros as Handler),
  ruta("POST", "/api/boards", crearTablero as Handler),
  ruta("GET", "/api/boards/:id", obtenerTablero as Handler),
  ruta("POST", "/api/boards/:id/columns", crearColumna as Handler),
  ruta("GET", "/api/tasks/search", buscarTareas as Handler),
  ruta("GET", "/api/tasks", listarTareas as Handler),
  ruta("POST", "/api/tasks", crearTarea as Handler),
  ruta("POST", "/api/tasks/:id/move", moverTarea as Handler),
  ruta("GET", "/api/tasks/:id", obtenerTarea as Handler),
  ruta("PATCH", "/api/tasks/:id", actualizarTarea as Handler),
  ruta("DELETE", "/api/tasks/:id", borrarTarea as Handler),
];

function resolver(metodo: string, camino: string): { handler: Handler; id: string } | undefined {
  const segmentos = camino.split("/").filter((parte) => parte !== "");

  for (const candidata of RUTAS) {
    if (candidata.metodo !== metodo || candidata.patron.length !== segmentos.length) {
      continue;
    }

    let id = "";
    const coincide = candidata.patron.every((parte, indice) => {
      const segmento = segmentos[indice] ?? "";
      if (parte === ":id") {
        id = decodeURIComponent(segmento);
        return true;
      }
      return parte === segmento;
    });

    if (coincide) {
      return { handler: candidata.handler, id };
    }
  }

  return undefined;
}

async function leerCuerpo(req: IncomingMessage): Promise<Buffer> {
  const trozos: Buffer[] = [];
  for await (const trozo of req) {
    trozos.push(trozo as Buffer);
  }
  return Buffer.concat(trozos);
}

function cabeceras(req: IncomingMessage): Headers {
  const salida = new Headers();
  for (const [nombre, valor] of Object.entries(req.headers)) {
    if (valor === undefined) {
      continue;
    }
    for (const uno of Array.isArray(valor) ? valor : [valor]) {
      salida.append(nombre, uno);
    }
  }
  return salida;
}

export interface ServidorRest {
  /** Raiz sin barra final, lista para `baseUrl` de `HttpPort`. */
  readonly url: string;
  cerrar(): Promise<void>;
}

/**
 * Levanta el servidor en un puerto libre (`:0`) y devuelve su URL.
 *
 * Puerto efimero y no uno fijo: la suite corre con un solo worker pero comparte
 * la maquina con `next dev` y `next start` del mismo `verify`, y un puerto fijo
 * es la forma de que un test falle por lo que ocupa otro proceso.
 */
export async function levantarServidorRest(): Promise<ServidorRest> {
  const servidor: Server = createServer((req, res) => {
    void atender(req, res);
  });

  await new Promise<void>((resolver) => servidor.listen(0, "127.0.0.1", resolver));

  const direccion = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${direccion.port}`,
    cerrar: () =>
      new Promise<void>((listo, fallo) => {
        servidor.close((error) => (error === undefined ? listo() : fallo(error)));
      }),
  };
}

async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const metodo = req.method ?? "GET";
    const camino = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const elegida = resolver(metodo, camino);

    if (elegida === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "NOT_FOUND", message: `Sin ruta para ${metodo} ${camino}.` } }),
      );
      return;
    }

    const cuerpo = await leerCuerpo(req);
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: metodo,
      headers: cabeceras(req),
      // Un GET o un DELETE con `body` —aunque sea vacio— lo rechaza `Request`.
      // `Uint8Array` y no el `Buffer` de Node: lo primero es lo que declara
      // `BodyInit`, y `Buffer` no le encaja aunque en ejecucion funcione igual.
      ...(cuerpo.byteLength === 0 ? {} : { body: new Uint8Array(cuerpo) }),
    });

    const respuesta = await elegida.handler(request, {
      params: Promise.resolve({ id: elegida.id }),
    });

    const salida: Record<string, string> = {};
    respuesta.headers.forEach((valor, nombre) => {
      salida[nombre] = valor;
    });

    res.writeHead(respuesta.status, salida);
    // Un 204 trae `body: null` y `arrayBuffer()` devuelve cero bytes, que es lo
    // que hay que escribir: `res.end` con un buffer vacio no agrega cuerpo.
    res.end(Buffer.from(await respuesta.arrayBuffer()));
  } catch (error: unknown) {
    // El servidor de prueba no tiene que tapar un fallo suyo con un 500 mudo: si
    // algo revienta aca, el mensaje tiene que llegar al test.
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ servidorDePrueba: String(error) }));
  }
}
