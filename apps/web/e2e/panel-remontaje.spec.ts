import type { Locator, Page } from "@playwright/test";

import { DESCRIPCION_DE_CONTRATO, TITULO_MEDIA, TITULO_URGENTE } from "./semilla";
import {
  campoDelPanel,
  esperarEscuchando,
  expect,
  retenerAcciones,
  tarjeta,
  test,
} from "./tablero";

/**
 * DOS DEFECTOS DEL PANEL DE DETALLE, REPRODUCIDOS. Son las dos entradas de
 * "Deuda conocida" de CLAUDE.md sobre el remontaje del editor: guardar un campo
 * cambia el `key` de `TaskEditor` (`task-detail-panel.tsx`), que lleva los
 * cuatro valores, y cuando llega la revalidacion el editor entero se remonta.
 *
 * --- COMO SE ORDENA SIN CARRERA ---------------------------------------------
 *
 * En la pantalla de una persona, que el remontaje le quite el foco depende de
 * cuanto tarda la respuesta frente a lo que ella tarda en pulsar Tab o la flecha
 * siguiente. Aca no se compite con ese tiempo: `retenerAcciones` detiene la
 * Server Action antes de que llegue al servidor, la prueba hace lo suyo, y
 * recien entonces la suelta. El arbol revalidado viaja en la respuesta, asi que
 * no puede llegar antes. Cada defecto tiene una prueba de MONTAJE que lo afirma.
 *
 * NO SE CORTA `/eventos`, y esta medido que no hace falta. Con la PETICION
 * retenida el servidor todavia no escribio, asi que no hay aviso: con el flujo
 * vivo, tres segundos de retencion dieron cero refrescos del router y la misma
 * textarea. Y aunque lo hubiera, tampoco traeria el arbol antes: reteniendo la
 * RESPUESTA, con el servidor ya escrito y el aviso ya recibido, el refresco que
 * ese aviso dispara salio recien despues de soltarla. Se deja vivo porque es lo
 * que tiene la pantalla de un usuario.
 *
 * --- POR QUE `test.fail()` ---------------------------------------------------
 *
 * DECISION TOMADA: las pruebas de los defectos afirman el comportamiento
 * CORRECTO, hoy fallan, y entran marcadas con `test.fail()`. LA MARCA SE QUITA
 * EL DIA QUE SE ARREGLE EL DEFECTO: con el arreglo la prueba pasa, Playwright la
 * da por fallida ("expected to fail, but passed") y `verify` se pone rojo hasta
 * que alguien la quite. Guardarlas para commitearlas junto al arreglo
 * significaria perderlas si el arreglo se pospone, y lo que vive fuera del repo
 * se evapora.
 *
 * LA TRAMPA DE LA MARCA: `test.fail()` acepta CUALQUIER fallo, no el que se
 * busca. Si el montaje se rompiera —la retencion deja de retener, Tab ya no
 * llega a la descripcion, la flecha ya no cambia el select—, la prueba marcada
 * fallaria por eso y seguiria verde, tapando el defecto con otra cosa. Por eso
 * cada una tiene al lado una prueba de MONTAJE sin marca, que vale igual con el
 * defecto arreglado: si el montaje se rompe, la que se pone roja es esa.
 */

/** Refrescos del router pedidos desde ahora: GET con `rsc` que no son prefetch. */
function contarRefrescos(page: Page): () => number {
  let cuantos = 0;

  page.on("request", (peticion) => {
    const cabeceras = peticion.headers();

    if (
      peticion.method() === "GET" &&
      cabeceras["rsc"] === "1" &&
      cabeceras["next-router-prefetch"] === undefined
    ) {
      cuantos += 1;
    }
  });

  return () => cuantos;
}

/**
 * Marca el nodo del DOM con una propiedad de JavaScript. Un remontaje lo
 * reemplaza por un nodo nuevo, que no la tiene: es la forma de ver un remontaje
 * desde fuera de React.
 */
async function marcarNodo(campo: Locator): Promise<void> {
  await campo.evaluate((nodo) => {
    (nodo as unknown as { __marca?: boolean }).__marca = true;
  });
}

async function esElMismoNodo(campo: Locator): Promise<boolean> {
  return campo.evaluate((nodo) => (nodo as unknown as { __marca?: boolean }).__marca === true);
}

/** Dos fotogramas: lo que React tenia pendiente de pintar, ya se pinto. */
async function fotograma(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((listo) => requestAnimationFrame(() => requestAnimationFrame(listo))),
  );
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
  // El flujo de cambios vivo, como en la pantalla de un usuario. Ver arriba.
  await esperarEscuchando(page);
});

// --- 1. Tab del titulo a la descripcion ------------------------------------

const TITULO_EDITADO = "Revisar el contrato OpenAPI y su tabla";
const TECLEADO = " y lo que se tecleo con el guardado en vuelo";

/**
 * EL MONTAJE DEL DEFECTO 1, compartido por sus dos pruebas: editar el titulo,
 * pasar con Tab a la descripcion —el blur del titulo guarda, y esa accion queda
 * retenida— y teclear ahi. Vuelve con la accion TODAVIA retenida.
 */
async function pasarConTabYTeclear(page: Page) {
  await tarjeta(page, TITULO_MEDIA).click();

  const titulo = campoDelPanel(page, "Titulo");
  const descripcion = campoDelPanel(page, "Descripcion");

  await expect(titulo).toHaveValue(TITULO_MEDIA);

  const acciones = await retenerAcciones(page);
  const refrescos = contarRefrescos(page);

  await titulo.fill(TITULO_EDITADO);
  await page.keyboard.press("Tab");

  // El blur guardo: la accion salio del navegador y quedo retenida.
  await expect
    .poll(() => acciones.retenidas(), { message: "Server Actions retenidas" })
    .toBe(1);

  await expect(descripcion).toBeFocused();
  await marcarNodo(descripcion);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(TECLEADO);

  return { acciones, refrescos, descripcion };
}

test("MONTAJE 1: con la accion retenida no llega ningun arbol nuevo, y al soltarla si", async ({
  page,
}) => {
  const { acciones, refrescos, descripcion } = await pasarConTabYTeclear(page);

  try {
    // Mientras esta retenida: ningun refresco pedido, la tarjeta con el titulo
    // de antes, la misma textarea y lo tecleado adentro.
    expect(refrescos(), "refrescos del router con la accion retenida").toBe(0);
    await expect(tarjeta(page, TITULO_MEDIA)).toBeVisible();
    await expect(tarjeta(page, TITULO_EDITADO)).toHaveCount(0);
    expect(await esElMismoNodo(descripcion), "la textarea es la misma").toBe(true);
    await expect(descripcion).toHaveValue(DESCRIPCION_DE_CONTRATO + TECLEADO);
  } finally {
    acciones.soltar();
  }

  // Soltada, el arbol revalidado llega: la tarjeta muestra el titulo nuevo.
  await expect(tarjeta(page, TITULO_EDITADO)).toBeVisible();
});

test.fail("DEUDA 1: cuando llega la revalidacion, la descripcion conserva el foco y lo tecleado", async ({
  page,
}) => {
  // MARCADA con `test.fail()`: hoy falla, y ese fallo es el defecto. Se quita la
  // marca el dia que se arregle (ver la cabecera).
  const { acciones, descripcion } = await pasarConTabYTeclear(page);

  acciones.soltar();

  // El arbol revalidado llego —la tarjeta lo muestra, y el panel viaja en el
  // mismo—, asi que lo de abajo ya ve el remontaje, si lo hay.
  await expect(tarjeta(page, TITULO_EDITADO)).toBeVisible();

  await expect(descripcion).toBeFocused();
  await expect(descripcion).toHaveValue(DESCRIPCION_DE_CONTRATO + TECLEADO);
});

// --- 2. La prioridad con flechas -------------------------------------------

/** Abre la tarea URGENT, retiene las acciones y enfoca el select de prioridad. */
async function enfocarLaPrioridad(page: Page) {
  await tarjeta(page, TITULO_URGENTE).click();

  const select = campoDelPanel(page, "Prioridad");

  await expect(select).toHaveValue("URGENT");

  const acciones = await retenerAcciones(page);

  await select.focus();

  return { acciones, select };
}

test("MONTAJE 2: una flecha sobre el select cerrado cambia su valor sin quitarle el foco", async ({
  page,
}) => {
  const { acciones, select } = await enfocarLaPrioridad(page);

  try {
    // Es lo que hace este Chromium con un select cerrado, medido tambien fuera
    // de la app, con un `<select>` pelado. Si dejara de hacerlo, la prueba
    // marcada de abajo fallaria sin haber elegido nada.
    await page.keyboard.press("ArrowDown");
    await expect(select).toHaveValue("HIGH");
    await expect(select).toBeFocused();
  } finally {
    acciones.soltar();
  }
});

test.fail("DEUDA 2: elegir la prioridad con dos flechas y salir con Tab guarda la que se ve", async ({
  page,
}) => {
  // MARCADA con `test.fail()`: hoy falla, y ese fallo es el defecto. Se quita la
  // marca el dia que se arregle (ver la cabecera).
  const { acciones, select } = await enfocarLaPrioridad(page);

  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("HIGH");

  /**
   * Dos fotogramas antes de la segunda flecha, para que el guardado de la
   * primera ya este EN VUELO para el componente cuando ella llega. Sin esto la
   * segunda podria entrar antes de que React pinte el `enVuelo` y guardarse
   * tambien, y la prueba pasaria —o sea, se pondria roja por la marca— sin que
   * nadie hubiera arreglado nada.
   */
  await fotograma(page);
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("MEDIUM");

  // Salir del campo, que es donde la 9.3 guarda.
  await page.keyboard.press("Tab");
  acciones.soltar();

  // MEDIUM no lleva chip: si se guardo la que se ve, la tarjeta termina sin el.
  // Hoy termina con "Alta", el valor intermedio: la segunda flecha se descarto
  // porque la primera estaba en vuelo.
  await expect(tarjeta(page, TITULO_URGENTE).locator(".prioridad")).toHaveCount(0);
});
