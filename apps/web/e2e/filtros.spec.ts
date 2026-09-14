import type { Priority } from "@taskman/core";

import { TITULO_ALTA, TITULO_MEDIA, TITULO_VENCIDA_EN_DONE, TITULO_VENCIDA_FUERA } from "./semilla";
import type { TableroSembrado } from "./semilla";
import {
  columna,
  expect,
  filtro,
  filtroPuesto,
  panel,
  tarjeta,
  test,
  esperarTitulos,
  titulosDelTablero,
  titulosMarcadosVencidos,
} from "./tablero";

/**
 * CT-09 de la 10.2: "Filtrar por prioridad y por tareas vencidas; verificar el
 * conjunto resultante." Es el primero de los diez escenarios de esa seccion que
 * queda cubierto de punta a punta.
 *
 * EL FILTRADO LO HACE EL NUCLEO. Estas pruebas miran la pantalla, asi que no
 * pueden ver la diferencia entre "la consulta trajo tres tareas" y "trajo once y
 * el navegador escondio ocho": las dos pintan lo mismo. Lo que si atan es el
 * CONJUNTO resultante, que es lo que la 6.3.2 define, y en particular el caso que
 * decide —el conjunto de vencidas— comparando dos cosas que produce la
 * aplicacion: lo que el filtro devuelve y lo que la UI marca.
 */

/** Los titulos sembrados que cumplen un predicado, en el orden del tablero. */
function titulosSembrados(
  activo: TableroSembrado,
  cumple: (tarea: { priority: Priority; vence: number | null }) => boolean,
): string[] {
  return activo.columnas.flatMap((definicion) =>
    definicion.tareas.filter(cumple).map((tarea) => tarea.title),
  );
}

function dePrioridad(activo: TableroSembrado, ...prioridades: Priority[]): string[] {
  return titulosSembrados(activo, (tarea) => prioridades.includes(tarea.priority));
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

// --- 1. Prioridad, y el OR de la 6.3.2 --------------------------------------

test("filtrar por HIGH muestra solo las HIGH, y HIGH mas URGENT actua como OR", async ({
  page,
  sembrado,
}) => {
  const { activo } = sembrado;

  // Punto de partida: el tablero entero.
  await expect(titulosDelTablero(page)).toHaveCount(
    activo.columnas.reduce((suma, definicion) => suma + definicion.tareas.length, 0),
  );

  await filtro(page, "Alta").click();

  // SOLO las HIGH. La lista se deriva de la semilla, no se escribe a mano: si
  // alguien agrega una tarea al sembrado, la prueba sigue diciendo la verdad.
  const altas = dePrioridad(activo, "HIGH");
  expect(altas.length).toBeGreaterThan(1); // reparte en dos columnas, o no prueba nada
  await esperarTitulos(page, altas);

  // El chip encendido lo dice, y ahora ofrece quitarlo.
  await expect(filtroPuesto(page, "Alta")).toBeVisible();

  // Y AHORA EL OR: se suma URGENT y aparecen las dos clases, ninguna MEDIUM.
  await filtro(page, "Urgente").click();

  const altasYUrgentes = dePrioridad(activo, "HIGH", "URGENT");
  await esperarTitulos(page, altasYUrgentes);

  // Explicito, porque es lo que distingue el OR del AND: con AND no quedaria
  // ninguna —ninguna tarea es HIGH y URGENT a la vez— y la pantalla estaria
  // vacia en vez de tener mas tareas que antes.
  expect(altasYUrgentes.length).toBeGreaterThan(altas.length);
  await expect(tarjeta(page, TITULO_MEDIA)).toHaveCount(0);
});

// --- 2. Vencidas: el conjunto filtrado ES el conjunto marcado ---------------

test("filtrar por vencidas devuelve exactamente las que la UI marca como vencidas", async ({
  page,
}) => {
  /**
   * ESTE ES EL CASO QUE DECIDE, y por eso los dos conjuntos se leen del DOM en
   * vez de derivarse de la semilla: lo que hay que probar es que el filtro y la
   * marca coinciden, y recalcular cualquiera de los dos aca seria una TERCERA
   * definicion de "vencida" que podria coincidir con la semilla y no con el
   * codigo. La unica definicion vive en `domain/vencimiento.ts`, y estas dos
   * lecturas son sus dos consumidores.
   */
  const marcadas = await titulosMarcadosVencidos(page);
  expect(marcadas.length).toBeGreaterThan(0);

  // La vencida que esta en DONE: su fecha paso, se ve en el tablero, y NO esta
  // marcada. Es la mitad de la regla que se pierde al mirar solo la fecha.
  await expect(tarjeta(page, TITULO_VENCIDA_EN_DONE)).toBeVisible();
  expect(marcadas).not.toContain(TITULO_VENCIDA_EN_DONE);

  await filtro(page, "Vencidas").click();

  await esperarTitulos(page, marcadas);

  // Dicho al reves, que es como falla si el filtro se escribe por su cuenta: la
  // de DONE tiene fecha pasada y NO tiene que aparecer.
  await expect(tarjeta(page, TITULO_VENCIDA_EN_DONE)).toHaveCount(0);
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).toBeVisible();
});

// --- 3. Los dos juntos: AND entre filtros, OR dentro de prioridad -----------

test("prioridad y vencidas se combinan con AND", async ({ page, sembrado }) => {
  const { activo } = sembrado;

  const medias = dePrioridad(activo, "MEDIUM");
  await filtro(page, "Media").click();
  await esperarTitulos(page, medias);

  await filtro(page, "Vencidas").click();
  await esperarTitulos(page, [TITULO_VENCIDA_FUERA]);
  const ambos = await titulosDelTablero(page).allTextContents();

  // El resultado es la INTERSECCION: menos que cada filtro por separado, y todo
  // lo que queda cumple los dos.
  expect(ambos.length).toBeGreaterThan(0);
  expect(ambos.length).toBeLessThan(medias.length);
  for (const titulo of ambos) {
    expect(medias).toContain(titulo);
  }
  expect(ambos).toEqual([TITULO_VENCIDA_FUERA]);
});

// --- 4. Una columna sin coincidencias sigue visible y vacia -----------------

test("con un filtro puesto, una columna sin coincidencias sigue visible y vacia", async ({
  page,
  sembrado,
}) => {
  const { activo } = sembrado;

  await filtro(page, "Alta").click();

  // LAS CUATRO COLUMNAS SIGUEN AHI. Un tablero al que le desaparecen columnas
  // segun el filtro cambia de forma y desorienta.
  await expect(page.locator(".columna__nombre")).toHaveText(
    activo.columnas.map((definicion) => definicion.name),
  );

  for (const definicion of activo.columnas) {
    const seccion = columna(page, definicion.name);
    const conFiltro = definicion.tareas.filter((tarea) => tarea.priority === "HIGH");

    await expect(seccion).toBeVisible();
    await expect(seccion.locator(".tarjeta")).toHaveCount(conFiltro.length);

    // El recuento dice las dos cosas: lo que se ve y el total de la columna.
    await expect(seccion.locator(".columna__recuento")).toHaveText(
      `${conFiltro.length} de ${definicion.tareas.length}`,
    );

    if (conFiltro.length === 0) {
      // Y el hueco no queda mudo: dice POR QUE esta vacio, que no es lo mismo
      // que una columna sin tareas.
      await expect(seccion.locator(".columna__vacia")).toHaveText("Ninguna con este filtro");
    }
  }
});

// --- 5. Sobrevive al recargado y el enlace se comparte ----------------------

test("el filtro sobrevive al recargado y la URL se puede compartir", async ({ page, sembrado }) => {
  const { activo } = sembrado;
  const altas = dePrioridad(activo, "HIGH");

  await filtro(page, "Alta").click();
  // El tablero va PRIMERO en la cadena y siempre esta: todo enlace de la pagina
  // lo lleva (ver `enlaceTablero`).
  await expect(page).toHaveURL(/\?tablero=[^&]+&prioridad=HIGH$/u);

  await page.reload();
  await esperarTitulos(page, altas);
  await expect(filtroPuesto(page, "Alta")).toBeVisible();

  // Y la misma URL abierta en frio da la misma pantalla, que es lo que significa
  // "se puede compartir".
  await page.goto("/?prioridad=HIGH&vencidas=1");
  await expect(filtroPuesto(page, "Alta")).toBeVisible();
  await expect(filtroPuesto(page, "Vencidas")).toBeVisible();
});

// --- 6. Quitar el filtro en un paso -----------------------------------------

test("quitar filtros devuelve el tablero completo en un paso", async ({ page, sembrado }) => {
  const { activo } = sembrado;
  const completo = activo.columnas.flatMap((definicion) =>
    definicion.tareas.map((tarea) => tarea.title),
  );

  // Con NADA puesto no hay nada que quitar, asi que el enlace no esta: su
  // ausencia es tambien la senal de que el tablero esta entero.
  await expect(page.getByRole("link", { name: "Quitar filtros" })).toHaveCount(0);

  await filtro(page, "Alta").click();
  /**
   * SE ESPERA A QUE EL PRIMER FILTRO ESTE PUESTO antes de pulsar el segundo, y
   * no es cortesia: cada chip es un ENLACE cuyo `href` se calcula con los
   * filtros que habia AL RENDERIZARLO (ver `enlaceTablero`). Pulsar "Vencidas"
   * antes de que llegue el arbol con "Alta" aplicado sigue el href viejo —el que
   * dice "solo vencidas"— y el tablero termina con UN filtro en vez de dos.
   *
   * No es un fallo del producto: un enlace apunta a donde apuntaba cuando se
   * dibujo, y eso es justamente lo que hace que lo que se ve encendido y lo que
   * se aplica no puedan discrepar. Es la prueba la que tiene que encadenar.
   *
   * Estaba latente desde que se escribio y salto la primera vez con la maquina
   * cargada: 1 de 42 en una corrida completa, 0 de 10 corriendo el archivo solo.
   * Por eso se arregla y no se reintenta (ver `playwright.config.ts`).
   */
  await expect(filtroPuesto(page, "Alta")).toBeVisible();

  await filtro(page, "Vencidas").click();
  // Alta y vencidas a la vez no deja ninguna: es el estado mas distinto posible
  // del tablero completo, asi que el paso siguiente tiene todo que recuperar.
  await esperarTitulos(page, []);

  // UN SOLO PASO, no uno por filtro puesto.
  await page.getByRole("link", { name: "Quitar filtros" }).click();

  await esperarTitulos(page, completo);
  await expect(page.getByRole("link", { name: "Quitar filtros" })).toHaveCount(0);
  await expect(filtro(page, "Alta")).toBeVisible();
  await expect(filtro(page, "Vencidas")).toBeVisible();
});

// --- 7. El filtro y el panel conviven en la URL -----------------------------

test("abrir y cerrar el panel de detalle no pierde el filtro", async ({ page, sembrado }) => {
  const { activo } = sembrado;
  const altas = dePrioridad(activo, "HIGH");

  await filtro(page, "Alta").click();
  await tarjeta(page, TITULO_ALTA).click();

  // Los dos estados a la vez.
  await expect(panel(page)).toBeVisible();
  await expect(filtroPuesto(page, "Alta")).toBeVisible();
  await esperarTitulos(page, altas);
  await expect(page).toHaveURL(/prioridad=HIGH/u);
  await expect(page).toHaveURL(/tarea=/u);

  // Cerrar con el enlace deja el filtro.
  await panel(page).getByRole("link", { name: "Cerrar el detalle" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(filtroPuesto(page, "Alta")).toBeVisible();
  await esperarTitulos(page, altas);

  // Y cerrar con Escape tambien: es el otro camino, y va al mismo sitio porque
  // los dos usan el mismo `hrefCerrar`.
  await tarjeta(page, TITULO_ALTA).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(panel(page)).toHaveCount(0);
  await expect(filtroPuesto(page, "Alta")).toBeVisible();
  await esperarTitulos(page, altas);
});
