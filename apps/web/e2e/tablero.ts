import { test as base, expect, type Locator, type Page } from "@playwright/test";

import {
  sembrar,
  tableroActivo,
  type NombreDeSemilla,
  type Semilla,
  type TableroSembrado,
} from "./semilla";

/**
 * El `test` de estas pruebas: el de Playwright con la siembra de la 10.3
 * enganchada, mas los localizadores del tablero.
 *
 * POR QUE UNA FIXTURE Y NO UN `beforeAll`. La siembra corre antes de CADA prueba
 * y vacia la base entera. Con un `beforeAll` por archivo seria mas rapido, pero
 * la segunda prueba de un archivo pasaria a depender de que la primera no haya
 * tocado nada, y esa dependencia no se ve al leerla: se descubre el dia que una
 * prueba nueva escribe algo. Es la misma decision que el `beforeEach` con
 * TRUNCATE de las suites de vitest, y es lo que hace que dos corridas seguidas
 * sin limpiar nada den lo mismo.
 *
 * LA SEMILLA ES UNA OPCION, no un parametro: un archivo entero elige la suya con
 * `test.use({ semilla: "vacio" })`. Asi la eleccion se lee arriba del archivo y no
 * repetida en cada prueba.
 */

export interface DatosSembrados {
  /** La semilla completa, tal como se escribio. */
  semilla: Semilla;
  /** El tablero que la pagina muestra: el primero del listado. */
  activo: TableroSembrado;
  /**
   * El instante contra el que se resolvieron los desplazamientos de fecha. Las
   * aserciones tienen que usar ESTE y no un `new Date()` propio.
   */
  hoy: Date;
}

export const test = base.extend<{
  semilla: NombreDeSemilla;
  sembrado: DatosSembrados;
}>({
  semilla: ["principal", { option: true }],

  sembrado: async ({ semilla }, use) => {
    const hoy = new Date();
    const datos = await sembrar(semilla, hoy);

    await use({ semilla: datos, activo: tableroActivo(datos), hoy });
  },
});

export { expect };

// --- Localizadores -----------------------------------------------------------

/**
 * Una columna POR SU NOMBRE ACCESIBLE, no por su posicion ni por su clase. El
 * `<section>` de `ColumnCard` lleva `aria-labelledby` apuntando a su `<h2>`, asi
 * que esto es la region que un lector de pantalla anunciaria con ese nombre: si
 * ese enlace se rompiera, la prueba deja de encontrar la columna, que es
 * exactamente lo que hay que enterarse.
 */
export function columna(page: Page, nombre: string): Locator {
  return page.getByRole("region", { name: nombre, exact: true });
}

/** Las tarjetas de una columna, en el orden del DOM (que es el de `position`). */
export function tarjetasDe(page: Page, nombreColumna: string): Locator {
  return columna(page, nombreColumna).locator(".tarjeta");
}

/** Una tarjeta concreta, por el titulo con el que se sembro. */
export function tarjeta(page: Page, titulo: string): Locator {
  return page.locator(".tarjeta").filter({ has: page.locator(`h3[title="${titulo}"]`) });
}

/** El `<h3>` de una tarjeta: es el elemento al que se le aplica el recorte. */
export function tituloDe(page: Page, titulo: string): Locator {
  return tarjeta(page, titulo).locator(".tarjeta__titulo");
}

/**
 * El campo del QuickAdd de una columna, POR SU NOMBRE ACCESIBLE.
 *
 * Hay uno por columna y los cuatro son el mismo marcado, asi que localizarlo por
 * clase obligaria a contar o a elegir el n-esimo. El `aria-label` que pone
 * `QuickAdd` lleva el nombre de la columna justamente para que "el campo de Por
 * hacer" sea una cosa nombrable, y esto lo pide por ahi: si ese nombre se
 * rompiera, la prueba deja de encontrar el campo, que es lo que hay que saber.
 */
export function campoNuevaTarea(page: Page, nombreColumna: string): Locator {
  return columna(page, nombreColumna).getByRole("textbox", {
    name: `Nueva tarea en ${nombreColumna}`,
    exact: true,
  });
}

// --- Cambios de otro actor (9.1) ---------------------------------------------

/**
 * CORTA EL FLUJO DE CAMBIOS para esta pagina, de forma DEFINITIVA.
 *
 * Se responde 204 y no se aborta la peticion: ante un error de red
 * `EventSource` reintenta cada pocos segundos, y ante una respuesta que no es
 * `text/event-stream` da la conexion por fallida y NO reintenta. O sea que 204
 * deja el tablero sordo de verdad, que es lo que la prueba necesita, en vez de
 * sordo a ratos.
 *
 * PARA QUE SIRVE: hay pruebas —las de la reconciliacion de la 9.2— cuyo montaje
 * exige que la pantalla NO se entere de un cambio ajeno. Antes de que existiera
 * `/eventos` eso era gratis, porque la pagina no consultaba sola; ahora hay que
 * pedirlo.
 *
 * Y NO ES UN APAÑO PARA QUE PASEN: es lo que hace que sigan midiendo lo suyo. La
 * reconciliacion es la red que queda cuando la pantalla esta desactualizada,
 * SEA CUAL SEA el motivo, y el motivo mas realista hoy es justamente este —el
 * flujo caido, que no tiene cola y no recupera lo perdido—. Probarla con el
 * flujo cortado no es simular una condicion de laboratorio: es la condicion en
 * la que hace falta.
 *
 * Hay que llamarla ANTES de cargar la pagina; despues, la carrera con la
 * hidratacion decide si llega a tiempo.
 */
export async function cortarElFlujoDeCambios(page: Page): Promise<void> {
  await page.route("**/eventos", (ruta) => ruta.fulfill({ status: 204 }));
}

/** Que el tablero NO este escuchando: el complemento de `esperarEscuchando`. */
export async function esperarSordo(page: Page): Promise<void> {
  await expect(page.locator(".columnas")).toHaveAttribute("data-cambios", "conectando");
}

/**
 * ESPERA A QUE EL TABLERO ESTE ESCUCHANDO el flujo de `/eventos`.
 *
 * HAY QUE LLAMARLA ANTES DE CUALQUIER CAMBIO AJENO, y no es una precaucion:
 * `NOTIFY` no guarda nada para quien no esta escuchando, asi que un cambio hecho
 * entre que el servidor devuelve el HTML y que el navegador hidrata y abre el
 * `EventSource` se pierde de verdad. Sin esta espera, la prueba mide esa carrera
 * en vez de lo que dice medir: pasa o falla segun lo rapido que hidrate.
 *
 * ES UNA PROPIEDAD DEL PRODUCTO, no del runner. Ese hueco existe tambien para
 * una persona, y dura lo que tarda la primera hidratacion; despues no se vuelve a
 * abrir, porque una reconexion refresca al volver (ver `alReconectar`).
 */
export async function esperarEscuchando(page: Page): Promise<void> {
  await expect(page.locator(".columnas")).toHaveAttribute("data-cambios", "conectado");
}

/** Las tarjetas con la marca de "lo cambio otro y todavia no lo viste". */
export function tarjetasMarcadas(page: Page): Locator {
  return page.locator(".tarjeta--ajena");
}

/** Los titulos de esas tarjetas, como localizador (reintenta). */
export function titulosMarcados(page: Page): Locator {
  return page.locator(".tarjeta--ajena .tarjeta__titulo");
}

/**
 * MIRA LA PANTALLA: la señal de entrada que apaga las marcas.
 *
 * Es un movimiento del puntero y no un clic, a proposito: un clic sobre el
 * tablero abriria el panel de una tarjeta, y entonces la prueba no sabria si la
 * marca se apago por la mirada o por la navegacion. Ver `lib/usar-mirada.ts`.
 */
export async function mirar(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.mouse.move(8, 12);
}

// --- Arrastre ----------------------------------------------------------------

/**
 * EL ASA de una tarjeta, por su nombre accesible. Es el control por el que se
 * agarra una tarea con el TECLADO, y lo que hace posible que estas pruebas sean
 * deterministas: ver `arrastrar`.
 */
export function asaDe(page: Page, titulo: string): Locator {
  return page.getByRole("button", { name: `Mover ${titulo}`, exact: true });
}

/** El aviso de un movimiento que fallo (punto 4 de la 9.2). */
export function avisoDeMovimiento(page: Page): Locator {
  return page.locator(".aviso-movimiento");
}

/**
 * CUANTAS VECES la reconciliacion del punto 3 de la 9.2 corrigio al navegador.
 * Lo publica `ColumnList` en `data-correcciones`; ver ahi por que es un dato de
 * la pantalla y no instrumentacion de prueba.
 */
export async function correcciones(page: Page): Promise<number> {
  const valor = await page.locator(".columnas").getAttribute("data-correcciones");

  return Number(valor);
}

/**
 * ANOTA CADA ANIMACION que arranque una tarjeta, para poder comprobar que la
 * correccion de la 9.2 se VE MOVERSE en vez de saltar.
 *
 * POR QUE ASI Y NO MIRANDO `document.getAnimations()`. La correccion dura 220
 * ms; preguntar despues es una carrera, y preguntar dentro obligaria a una
 * espera fija, que es como se fabrica una prueba que falla en una maquina
 * cargada. Interceptando `Element.prototype.animate` ANTES de que cargue nada,
 * lo que queda anotado es un hecho —esta tarjeta se animo— que se puede leer
 * cuando ya termino todo.
 *
 * Se anota `data-tarea` ademas del titulo porque es lo que distingue una tarjeta
 * del tablero de cualquier otra cosa que se anime: la copia que viaja con el
 * puntero tambien lleva un titulo dentro, y tambien se anima al soltarla (es la
 * animacion de caida de dnd-kit), pero no lleva ese atributo.
 *
 * Hay que llamarlo ANTES de navegar: `addInitScript` corre en la navegacion
 * siguiente.
 */
export async function anotarAnimaciones(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const anotadas: { id: string | null; titulo: string }[] = [];

    Object.defineProperty(window, "__animaciones", { value: anotadas });

    const original = Element.prototype.animate;

    Element.prototype.animate = function (
      this: Element,
      ...argumentos: Parameters<Element["animate"]>
    ) {
      anotadas.push({
        id: this.getAttribute("data-tarea"),
        titulo: this.querySelector(".tarjeta__titulo")?.textContent ?? "",
      });

      return original.apply(this, argumentos);
    };
  });
}

/** Los titulos de las TARJETAS que se animaron, en el orden en que arrancaron. */
export async function tarjetasAnimadas(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const anotadas = (window as unknown as {
      __animaciones?: { id: string | null; titulo: string }[];
    }).__animaciones;

    // Solo las que llevan `data-tarea`: lo demas es la caida del `DragOverlay`.
    return (anotadas ?? []).filter((entrada) => entrada.id !== null).map((e) => e.titulo);
  });
}

/**
 * ARRASTRA UNA TAREA CON EL TECLADO hasta una columna y un indice CONCRETOS:
 * foco en el asa, Espacio para agarrar, flechas, Espacio para soltar.
 *
 * POR QUE EL TECLADO Y NO EL RATON, que es la pregunta del criterio 7.
 *
 * El arrastre con raton es una secuencia de coordenadas, y su resultado depende
 * de donde caiga cada tarjeta en pixeles: del alto que tomo un titulo de dos
 * lineas, de si la columna esta desplazada, del ancho de la ventana. Una prueba
 * asi no es "un poco fragil": afirma sobre una geometria que nadie declaro, asi
 * que cuando falla no se sabe si fallo el codigo o la cuenta de pixeles. Ademas
 * `dragTo` de Playwright emite un `pointerdown`, un `pointermove` y un
 * `pointerup`, y dnd-kit necesita VARIOS `pointermove` para pasar la
 * restriccion de distancia y para ir resolviendo colisiones: con uno solo el
 * arrastre ni siquiera empieza.
 *
 * El teclado no tiene nada de eso: "agarrar y pulsar la flecha derecha" es una
 * intencion DISCRETA, y ademas es un camino que la aplicacion tiene que
 * soportar igual (`KeyboardSensor`). O sea que la ruta determinista no es un
 * sucedaneo del gesto real: es el mismo `onDragEnd`, el mismo estado optimista,
 * la misma Server Action y la misma reconciliacion. Lo unico que no ejercita es
 * el sensor de puntero, que es la pieza de dnd-kit y no nuestra, y para eso hay
 * una prueba aparte con `arrastrarConRaton`.
 *
 * --- POR QUE MIRA EL DOM ENTRE TECLA Y TECLA --------------------------------
 *
 * Contar flechas a mano NO es determinista, y costo una tanda de pruebas rojas
 * descubrirlo. Dos motivos, los dos del algoritmo de dnd-kit
 * (`sortableKeyboardCoordinates`), que en cada flecha se queda con el destino
 * mas cercano ENTRE TODOS los del tablero en esa direccion:
 *
 *   - Cuantas flechas hacen falta para cruzar a otra columna depende de la
 *     geometria, no del numero de columnas.
 *   - Las flechas de mas NO se quedan quietas al llegar al extremo. Una flecha
 *     abajo de mas, con la tarjeta ya al pie de su columna, se va a la tarjeta
 *     de OTRA columna que este mas abajo, porque tambien esta "hacia abajo".
 *     Con eso, "seis flechas para asegurarme" saca la tarea del tablero que se
 *     estaba probando.
 *
 * Asi que en vez de contar, se MIRA: se pulsa la flecha horizontal hasta que la
 * tarjeta aparece en la columna destino —el cambio de columna SI se ve en el
 * DOM, porque lo aplica `onDragOver` sobre el estado local— y desde ahi se
 * pulsan exactamente las verticales que faltan hasta el indice pedido. Cada
 * flecha vertical dentro de una columna vale una posicion, eso si es discreto.
 *
 * El resultado es que la prueba declara la INTENCION ("a Por hacer, arriba del
 * todo") y no la mecanica, que es lo que se queria del teclado desde el principio.
 */
export async function arrastrar(page: Page, titulo: string, destino: Destino): Promise<void> {
  await agarrar(page, titulo);
  await llevarA(page, titulo, destino);
  await soltar(page);
}

/** Donde tiene que terminar una tarjeta. */
export interface Destino {
  /** Nombre de la columna. La misma en la que ya esta tambien vale. */
  columna: string;
  /** Indice DENTRO de esa columna: un numero, o los dos extremos. */
  indice: number | "principio" | "final";
}

/**
 * Las tres mitades de `arrastrar`, expuestas por separado.
 *
 * Existen porque hay una prueba que necesita METER ALGO EN MEDIO del gesto —un
 * agente que escribe con la tarjeta ya agarrada— y la unica forma de hacerlo sin
 * repetir la mecanica es poder abrir el gesto, hacer lo otro, y cerrarlo. Antes
 * esa prueba pulsaba las flechas a mano y por eso fallaba de forma intermitente:
 * se comia la espera de fotograma que explica `llevarAlIndice`, asi que dos
 * flechas seguidas se resolvian contra la misma geometria y la segunda no hacia
 * nada. Con la maquina cargada fallaba; sola, pasaba.
 */
export async function agarrar(page: Page, titulo: string): Promise<void> {
  await asaDe(page, titulo).focus();
  await page.keyboard.press("Space");
}

export async function llevarA(page: Page, titulo: string, destino: Destino): Promise<void> {
  try {
    await llevarALaColumna(page, titulo, destino.columna);
    await llevarAlIndice(page, titulo, destino.columna, destino.indice);
  } catch (error: unknown) {
    // Un arrastre a medias deja el tablero en un estado que no es ni el de
    // antes ni el de despues, y la prueba siguiente heredaria la tecla pulsada.
    await page.keyboard.press("Escape");

    throw error;
  }
}

export async function soltar(page: Page): Promise<void> {
  await soltandoYEsperandoAlServidor(page, () => page.keyboard.press("Space"));
}

/**
 * SUELTA Y ESPERA A QUE EL SERVIDOR CONTESTE.
 *
 * NO es una espera de cortesia: sin ella la prueba sigue mientras la Server
 * Action esta en vuelo, y lo siguiente que haga puede matarla. Costo una
 * intermitente de 1 de cada 8 para verlo, y siempre en la PRIMERA prueba
 * despues de arrancar el servidor, que es la unica lo bastante lenta para que
 * la ventana se note: `page.reload()` del CT-03 aborta la peticion de la accion
 * a mitad de la transaccion, el movimiento no llega a escribirse, y la prueba
 * lee un tablero sin mover. Se lee como "el arrastre no persiste" cuando lo que
 * pasa es que la prueba lo interrumpio.
 *
 * Se espera la RESPUESTA POST y no un estado de la pantalla porque es el unico
 * hito que no tiene carrera: cuando llega, la transaccion ya commiteo —el
 * cuerpo trae el `MoveResult` y el arbol revalidado— y a partir de ahi recargar,
 * leer la base o arrastrar otra vez es seguro. Esperar a que se apague el "en
 * vuelo" de la pantalla, en cambio, obliga a verlo encenderse primero, y eso si
 * es una carrera.
 *
 * CONSECUENCIA: `arrastrar` exige que el gesto produzca un movimiento. Un
 * arrastre que termina donde empezo no manda nada (ver `alSoltar`) y esto
 * agotaria su espera. Hoy ninguna prueba hace eso; el dia que haga falta, la
 * espera se hace opcional.
 */
async function soltandoYEsperandoAlServidor(
  page: Page,
  soltar: () => Promise<void>,
): Promise<void> {
  // La promesa se arma ANTES de soltar: la accion sale en el mismo tic.
  const respuesta = page.waitForResponse((r) => r.request().method() === "POST");

  await soltar();
  await respuesta;
}

/**
 * dnd-kit mueve la tarjeta en el commit siguiente a cada tecla, y la posicion
 * resultante es la ENTRADA de la tecla que viene. Sin dejar pasar un fotograma,
 * dos flechas seguidas se resuelven contra la misma geometria y la segunda no
 * hace nada.
 */
async function fotograma(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((listo) => requestAnimationFrame(() => requestAnimationFrame(listo))),
  );
}

/** Los titulos que se ven en una columna, leidos AHORA (sin reintentar). */
async function titulosDe(page: Page, nombreColumna: string): Promise<string[]> {
  return tarjetasDe(page, nombreColumna).locator(".tarjeta__titulo").allTextContents();
}

/** Los nombres de las columnas, en el orden en que estan en el tablero. */
async function columnasDelTablero(page: Page): Promise<string[]> {
  return page.locator(".columna__nombre").allTextContents();
}

/** En que columna esta AHORA la tarjeta, mirando el DOM. */
async function columnaActual(page: Page, titulo: string): Promise<string> {
  for (const nombre of await columnasDelTablero(page)) {
    if ((await titulosDe(page, nombre)).includes(titulo)) {
      return nombre;
    }
  }

  throw new Error(`"${titulo}" no esta en ninguna columna del tablero.`);
}

/**
 * Flechas horizontales hasta que la tarjeta aparece en la columna pedida.
 *
 * LA DIRECCION SE DEDUCE, no se pasa: se comparan las posiciones de la columna
 * actual y la destino en el tablero. Asi la prueba dice "a Completado" y no "tres
 * a la derecha", que es lo mismo hasta el dia que alguien reordene las columnas
 * de la 4.3 o el filtro deje una vacia por el camino.
 *
 * Se vuelve a mirar en CADA vuelta porque una flecha puede saltar mas de una
 * columna: el algoritmo de dnd-kit no va de vecina en vecina, se queda con el
 * destino mas cercano en esa direccion, y con columnas vacias o de alturas muy
 * distintas eso puede ser la de mas alla.
 */
async function llevarALaColumna(page: Page, titulo: string, destino: string): Promise<void> {
  const columnas = await columnasDelTablero(page);
  const indiceDestino = columnas.indexOf(destino);

  if (indiceDestino < 0) {
    throw new Error(`El tablero no tiene ninguna columna "${destino}".`);
  }

  // Cuatro columnas: ocho pulsaciones dan margen de sobra para cualquier
  // recorrido, y si se agotan es que las flechas no estan avanzando.
  for (let intento = 0; intento < 8; intento += 1) {
    const actual = await columnaActual(page, titulo);

    if (actual === destino) {
      return;
    }

    await page.keyboard.press(
      columnas.indexOf(actual) < indiceDestino ? "ArrowRight" : "ArrowLeft",
    );
    await fotograma(page);
  }

  throw new Error(
    `No se pudo llevar "${titulo}" a "${destino}": se quedo en "${await columnaActual(page, titulo)}".`,
  );
}

/** Flechas verticales hasta el indice pedido dentro de la columna. */
async function llevarAlIndice(
  page: Page,
  titulo: string,
  nombreColumna: string,
  indice: number | "principio" | "final",
): Promise<void> {
  const lista = await titulosDe(page, nombreColumna);
  const actual = lista.indexOf(titulo);

  if (actual < 0) {
    throw new Error(`"${titulo}" no esta en "${nombreColumna}" a mitad del arrastre.`);
  }

  const objetivo =
    indice === "principio" ? 0 : indice === "final" ? lista.length - 1 : indice;
  const tecla = objetivo > actual ? "ArrowDown" : "ArrowUp";

  for (let paso = 0; paso < Math.abs(objetivo - actual); paso += 1) {
    await page.keyboard.press(tecla);
    await fotograma(page);
  }
}

/**
 * AGARRA, MUEVE Y CANCELA con Escape. No suelta, asi que no manda nada al
 * servidor y no espera ninguna respuesta.
 *
 * Existe porque `onDragOver` cambia el estado local mientras se arrastra —la
 * tarjeta entra en la columna destino antes de soltarla— y eso hay que poder
 * deshacerlo: una cancelacion que dejara la tarjeta en la columna nueva seria
 * una pantalla afirmando un movimiento que nunca se escribio.
 */
export async function arrastrarYCancelar(
  page: Page,
  titulo: string,
  columnaDestino: string,
): Promise<void> {
  await asaDe(page, titulo).focus();
  await page.keyboard.press("Space");
  await llevarALaColumna(page, titulo, columnaDestino);
  await page.keyboard.press("Escape");
}

/**
 * El gesto REAL, con el puntero. Se usa en una sola prueba —la que comprueba
 * que agarrar una tarjeta con el raton la mueve y no abre el panel— y no en las
 * demas, por lo que explica `arrastrar`.
 *
 * Los `pointermove` son VARIOS y explicitos: uno para pasar la restriccion de
 * distancia de 6 px, los intermedios para que dnd-kit vaya resolviendo sobre
 * que columna esta, y uno final quieto sobre el destino para que la ultima
 * colision sea la que se soltara.
 */
export async function arrastrarConRaton(
  page: Page,
  titulo: string,
  destino: Locator,
): Promise<void> {
  const origen = await tarjeta(page, titulo).boundingBox();
  const caja = await destino.boundingBox();

  if (origen === null || caja === null) {
    throw new Error(`No se pudo medir el arrastre de "${titulo}".`);
  }

  const hasta = { x: caja.x + caja.width / 2, y: caja.y + caja.height / 2 };

  await page.mouse.move(origen.x + origen.width / 2, origen.y + origen.height / 2);
  await page.mouse.down();
  // El primer tramo solo sirve para superar la restriccion de distancia.
  await page.mouse.move(origen.x + origen.width / 2 + 12, origen.y + origen.height / 2);
  await page.mouse.move(hasta.x, hasta.y, { steps: 12 });
  await page.mouse.move(hasta.x, hasta.y);

  await soltandoYEsperandoAlServidor(page, () => page.mouse.up());
}

// --- Filtros -----------------------------------------------------------------

/**
 * Un chip de filtro POR LO QUE HACE, no por su etiqueta: "Filtrar por Alta"
 * cuando esta apagado y "Quitar el filtro Alta" cuando esta puesto. Ese nombre
 * accesible es el estado del filtro, asi que pedirlo asi comprueba de paso que la
 * pantalla anuncia bien lo que va a pasar al pulsarlo.
 */
export function filtro(page: Page, nombre: string): Locator {
  return page.getByRole("link", { name: `Filtrar por ${nombre}`, exact: true });
}

export function filtroPuesto(page: Page, nombre: string): Locator {
  return page.getByRole("link", { name: `Quitar el filtro ${nombre}`, exact: true });
}

/** Todos los titulos del tablero, como LOCALIZADOR. Ver `esperarTitulos`. */
export function titulosDelTablero(page: Page): Locator {
  return page.locator(".tarjeta__titulo");
}

/**
 * Espera a que el tablero muestre EXACTAMENTE estos titulos, en este orden.
 *
 * Va como asercion y no como `allTextContents()` porque `toHaveText` REINTENTA y
 * la lectura suelta no: pulsar un filtro navega del lado del cliente, asi que
 * leer justo despues del clic devuelve el tablero ANTERIOR. Paso al escribir
 * estas pruebas —cuatro fallaron leyendo el estado de antes, una de ellas con la
 * lista vacia porque el filtro previo no dejaba ninguna— y el sintoma se lee como
 * "el filtro no funciona" en vez de como "todavia no llego".
 */
export async function esperarTitulos(page: Page, titulos: readonly string[]): Promise<void> {
  await expect(titulosDelTablero(page)).toHaveText([...titulos]);
}

/**
 * Los titulos de las tarjetas que llevan la MARCA de vencida. Se lee del DOM y no
 * se recalcula: el caso que decide es que este conjunto y el que devuelve el
 * filtro sean el mismo, y compararlos exige que los dos salgan de la aplicacion.
 */
export async function titulosMarcadosVencidos(page: Page): Promise<string[]> {
  return page.locator(".tarjeta:has(time.fecha--vencida) .tarjeta__titulo").allTextContents();
}

// --- Panel de detalle --------------------------------------------------------

/**
 * El panel de detalle. Por CLASE y no por su nombre accesible, que lleva el
 * titulo de la tarea: eso lo haria cambiar justo en la prueba que edita el
 * titulo. El nombre se afirma aparte, donde interesa.
 */
export function panel(page: Page): Locator {
  return page.locator(".panel");
}

/**
 * Un campo del panel por su ETIQUETA, que es como lo encuentra una persona. Cada
 * control esta dentro de su `<label>`, asi que el nombre accesible sale del texto
 * de la etiqueta: si ese `<label>` se rompiera, la prueba deja de encontrar el
 * campo en vez de seguir andando por la clase CSS.
 */
export function campoDelPanel(page: Page, etiqueta: string): Locator {
  return panel(page).getByLabel(etiqueta, { exact: true });
}

// --- Lectura del render ------------------------------------------------------

/**
 * Una propiedad CALCULADA del elemento, no la declarada en la hoja.
 *
 * Es la diferencia entre esta suite y leer el HTML a mano: una clase presente en
 * el atributo no prueba que la regla se aplique —puede estar pisada, puede que la
 * hoja ni siquiera haya cargado— y `getComputedStyle` sale del motor despues de
 * resolver la cascada.
 */
export async function estiloCalculado(
  locator: Locator,
  propiedad: string,
): Promise<string> {
  return locator.evaluate(
    (elemento, nombre) => getComputedStyle(elemento).getPropertyValue(nombre),
    propiedad,
  );
}

export interface MedidaDeTitulo {
  /** Alto de la CAJA, ya recortada. */
  alto: number;
  /** Alto del CONTENIDO, sin recortar. Mayor que `alto` cuando algo se corto. */
  altoSinRecortar: number;
  /** El alto de UNA linea, leido del elemento y no supuesto. */
  lineaPx: number;
}

/**
 * Mide el titulo de una tarjeta. Es lo que no se podia comprobar leyendo el HTML:
 * el recorte a dos lineas es una regla de CSS, y cuantas lineas ocupa un texto no
 * esta escrito en ningun lado hasta que un motor de maquetado lo resuelve.
 *
 * `lineaPx` se LEE del elemento en vez de fijarse en la prueba. Un 19.6 escrito
 * aca convertiria a esta prueba en guardiana del `line-height`, que no es lo que
 * mide: cambiar la tipografia romperia el recorte sin que nadie lo haya tocado.
 * Leyendolo, lo que se afirma es la relacion —dos lineas y no una, ni tres— que
 * es la regla de verdad.
 */
export async function medirTitulo(locator: Locator): Promise<MedidaDeTitulo> {
  return locator.evaluate((elemento) => {
    const estilo = getComputedStyle(elemento);
    const lineaPx = Number.parseFloat(estilo.lineHeight);

    return {
      alto: elemento.getBoundingClientRect().height,
      altoSinRecortar: elemento.scrollHeight,
      lineaPx,
    };
  });
}
