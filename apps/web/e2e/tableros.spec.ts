import type { Page } from "@playwright/test";

import {
  columnasDelTableroEnLaBase,
  creacionesDeTablero,
  idDeTablero,
  idDeTarea,
  nombresDeTablerosEnLaBase,
} from "./base";
import {
  columnasVacias,
  TABLERO_OTRO,
  tableroSembrado,
  TITULO_ALTA,
  TITULO_OTRO_ALTA,
  TITULO_OTRO_MEDIA,
  titulosSembrados,
} from "./semilla";
import {
  avisoSinTablero,
  campoDelPanel,
  campoNuevoTablero,
  enlaceDeTablero,
  errorNuevoTablero,
  esperandoAlServidor,
  esperarTitulos,
  expect,
  filtro,
  filtroPuesto,
  itemsDeLaBarra,
  nombreDelTablero,
  panel,
  tableroMarcado,
  tarjeta,
  test,
} from "./tablero";

/**
 * EL SELECTOR DE TABLERO (9.3) Y LA CREACION DESDE LA PANTALLA (18 del funcional),
 * que cierran juntos el CT-01.
 *
 * Son dos requisitos y se prueban por separado, pero van en el mismo archivo por
 * lo que los junto: crear sin poder cambiar deja el tablero nuevo invisible, y
 * cambiar sin poder crear deja la 18 sin cumplir. El fallo que motiva el paso es
 * el primero, y por eso el tablero que crea el CT-01 tiene un nombre que ordena
 * ULTIMO: si no quedara seleccionado, la pantalla seguiria en el primero.
 *
 * LA PRUEBA QUE DECIDE ES LA 6. El tablero pasa a vivir en la URL junto al panel y
 * los filtros, y todos los enlaces que ya existian tienen que conservarlo: un
 * filtro, un cierre de panel o una tarjeta que no lo llevara te devolveria al
 * primer tablero SIN NINGUN ERROR. El typecheck ya obliga a cada enlace a pasar
 * un tablero (`enlaceTablero`); lo que no puede ver es si es EL tablero correcto,
 * y eso es lo que mira esa prueba.
 *
 * COMO SE EVITA EL FALSO VERDE en las pruebas de navegacion: despues de cada clic
 * se espera primero una senal de que el arbol NUEVO llego —el chip encendido, el
 * panel abierto o cerrado— y recien entonces se afirma el nombre del tablero. Si
 * se afirmara el nombre primero, pasaria leyendo la pantalla ANTERIOR, antes de
 * que la navegacion equivocada terminara de llevar al primer tablero.
 */

/** El nombre del tablero que crea el CT-01. Empieza por "3": ordena ULTIMO. */
const NUEVO = "3 Tablero creado desde la pantalla";

/** 121 caracteres: uno mas que `LIMITE_BOARD_NAME`. */
const NOMBRE_LARGUISIMO = "b".repeat(121);

/** Que la URL sea la de este tablero, con lo que venga detras. */
function urlDelTablero(id: string, resto = ""): RegExp {
  return new RegExp(`/\\?tablero=${id}${resto}$`, "u");
}

async function enElTablero(page: Page, nombre: string): Promise<void> {
  await expect(nombreDelTablero(page)).toHaveText(nombre);
  await expect(tableroMarcado(page)).toHaveCount(1);
  await expect(tableroMarcado(page)).toHaveText(nombre);
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

// --- 1. El segundo tablero se alcanza desde la barra ------------------------

test("con dos tableros, al segundo se llega desde la barra y de ahi se vuelve al primero", async ({
  page,
  sembrado,
}) => {
  const { activo, semilla } = sembrado;
  const otro = tableroSembrado(semilla, TABLERO_OTRO);

  // Punto de partida: `/` muestra el primero, y el segundo es un ENLACE en la
  // barra. `enlaceDeTablero` lo pide por rol: si los items siguieran siendo `<li>`
  // sueltos, esto no encontraria nada.
  await enElTablero(page, activo.name);
  await expect(enlaceDeTablero(page, TABLERO_OTRO)).toBeVisible();

  await enlaceDeTablero(page, TABLERO_OTRO).click();

  await enElTablero(page, TABLERO_OTRO);
  // SUS tareas y ninguna del primero: la cabecera podria cambiar de nombre sin
  // que cambiara lo cargado, y eso seria peor que no cambiar nada.
  await esperarTitulos(page, titulosSembrados(otro));
  await expect(tarjeta(page, TITULO_ALTA)).toHaveCount(0);
  await expect(page).toHaveURL(urlDelTablero(await idDeTablero(TABLERO_OTRO)));

  // Y de vuelta: el primero tambien es un enlace, no solo "lo que muestra /".
  await enlaceDeTablero(page, activo.name).click();

  await enElTablero(page, activo.name);
  await esperarTitulos(page, titulosSembrados(activo));
  await expect(page).toHaveURL(urlDelTablero(await idDeTablero(activo.name)));
});

// --- 2 y 8. CT-01: crear desde la pantalla ----------------------------------

/**
 * CT-01 de la 10.2: "Crear tablero, verificar que aparecen las cuatro columnas
 * por defecto". Con las tres mitades que la pantalla sola no da:
 *
 *   - QUE QUEDE SELECCIONADO, con un nombre que ordena ultimo. Es el caso en el
 *     que la regla por defecto mostraria otro.
 *   - LAS COLUMNAS POR SQL: key, nombre y position de la 4.3. La pantalla solo
 *     pinta nombres, y la key es lo que usan los agentes.
 *   - EL ACTOR USER EN `audit_log`: entro por la Server Action y no por otro
 *     borde.
 */
test("CT-01: crear un tablero desde la barra lo deja seleccionado, con las cuatro columnas de la 4.3", async ({
  page,
  sembrado,
}) => {
  const nombres = sembrado.semilla.tableros.map((tablero) => tablero.name);
  const campo = campoNuevoTablero(page);
  const cuatro = columnasVacias();

  await enElTablero(page, sembrado.activo.name);

  await campo.fill(NUEVO);
  // Se espera la respuesta de la accion antes de leer la base (ver
  // `esperandoAlServidor`).
  await esperandoAlServidor(page, () => campo.press("Enter"));

  // APARECE en la barra, en el lugar que le toca por nombre...
  await expect(itemsDeLaBarra(page)).toHaveText([...nombres, NUEVO]);

  // ...y QUEDA SELECCIONADO: es lo que se esta viendo, no solo lo que se lista.
  await enElTablero(page, NUEVO);
  await expect(page).toHaveURL(urlDelTablero(await idDeTablero(NUEVO)));

  // Las cuatro columnas en pantalla, en su orden, vacias.
  await expect(page.locator(".columna__nombre")).toHaveText(cuatro.map((columna) => columna.name));
  await expect(page.locator(".tarjeta")).toHaveCount(0);
  await expect(page.locator(".cabecera__recuento")).toHaveText("0 tareas");

  // El campo queda listo para otro, sin error.
  await expect(campo).toHaveValue("");
  await expect(errorNuevoTablero(page)).toHaveCount(0);

  // EN LA BASE: key, nombre y position de cada columna, que es la tabla de la 4.3
  // tal como `columnasVacias` la escribe a mano.
  expect(await columnasDelTableroEnLaBase(NUEVO)).toEqual(
    cuatro.map((columna, position) => ({ key: columna.key, name: columna.name, position })),
  );

  // UNO solo, y ninguno de los otros se toco.
  expect(await nombresDeTablerosEnLaBase()).toEqual([...nombres, NUEVO]);

  // Escrito por la UI: USER con el nombre de actor de `lib/actor.ts`.
  expect(await creacionesDeTablero(NUEVO)).toEqual([{ actorType: "USER", actorName: "web-ui" }]);

  // Y persiste: con documento nuevo, lo que se ve sale otra vez de la base.
  await page.reload();

  await enElTablero(page, NUEVO);
  await expect(page.locator(".columna__nombre")).toHaveText(cuatro.map((columna) => columna.name));
});

// --- 3. Sobrevive al recargado y la URL se comparte -------------------------

test("el tablero elegido sobrevive al recargado y su URL lo abre en otro navegador", async ({
  page,
  browser,
  sembrado,
}) => {
  await enlaceDeTablero(page, TABLERO_OTRO).click();
  await enElTablero(page, TABLERO_OTRO);

  const id = await idDeTablero(TABLERO_OTRO);
  await expect(page).toHaveURL(urlDelTablero(id));

  await page.reload();
  await enElTablero(page, TABLERO_OTRO);

  /**
   * COMPARTIR es abrir la URL donde no hay nada de esta sesion: otro CONTEXTO, sin
   * historial, sin la cache del router de Next y sin cookies. Si el tablero
   * elegido viviera en algo que no fuera la URL, aca se veria el primero.
   */
  const ajeno = await browser.newContext();

  try {
    const otraPestana = await ajeno.newPage();

    await otraPestana.goto(page.url());
    await expect(nombreDelTablero(otraPestana)).toHaveText(TABLERO_OTRO);
  } finally {
    await ajeno.close();
  }

  // Y `/` a secas sigue siendo el primero: lo que decide es la URL, no lo ultimo
  // que se eligio.
  await page.goto("/");
  await enElTablero(page, sembrado.activo.name);
});

// --- 4. Con un filtro puesto, cambiar de tablero ----------------------------

/**
 * DECISION: EL FILTRO VIAJA. Es un valor del enum de prioridad —el mismo en todos
 * los tableros— y la pantalla dibuja que esta puesto, asi que en el otro tablero
 * significa lo mismo y no esconde nada sin decirlo. El motivo completo esta en
 * `enlaceAOtroTablero` (lib/filtros.ts).
 */
test("con un filtro puesto, cambiar de tablero lo conserva y lo aplica al otro", async ({
  page,
  sembrado,
}) => {
  const otro = tableroSembrado(sembrado.semilla, TABLERO_OTRO);

  await filtro(page, "Alta").click();
  // El enlace de la barra se calcula con los filtros que habia AL RENDERIZAR: se
  // espera el arbol con el filtro puesto antes de pulsarlo. Ver el caso 6 de
  // `filtros.spec.ts`.
  await expect(filtroPuesto(page, "Alta")).toBeVisible();

  await enlaceDeTablero(page, TABLERO_OTRO).click();

  await enElTablero(page, TABLERO_OTRO);
  await expect(filtroPuesto(page, "Alta")).toBeVisible();

  // Aplicado al OTRO tablero: su unica HIGH, y el recuento dice lo que esconde.
  await esperarTitulos(page, [TITULO_OTRO_ALTA]);
  await expect(page.locator(".cabecera__recuento")).toHaveText(
    `1 de ${titulosSembrados(otro).length} tareas`,
  );

  await expect(page).toHaveURL(urlDelTablero(await idDeTablero(TABLERO_OTRO), "&prioridad=HIGH"));
});

// --- 5. Con el panel abierto, cambiar de tablero ----------------------------

/**
 * DECISION: EL PANEL SE CIERRA, y la tarea no queda en la URL. Es una tarea del
 * tablero que se deja; en el otro no hay nada que abrir.
 */
test("con el panel abierto, cambiar de tablero lo cierra y saca la tarea de la URL", async ({
  page,
  sembrado,
}) => {
  await tarjeta(page, TITULO_ALTA).click();
  await expect(panel(page)).toBeVisible();
  await expect(page).toHaveURL(/tarea=/u);

  await enlaceDeTablero(page, TABLERO_OTRO).click();

  // El panel desaparece con el mismo arbol que trae el otro tablero, asi que
  // esperar esto primero es esperar la navegacion.
  await expect(panel(page)).toHaveCount(0);
  await enElTablero(page, TABLERO_OTRO);
  await expect(page).toHaveURL(urlDelTablero(await idDeTablero(TABLERO_OTRO)));

  // Volver al primero NO reabre el panel: la tarea no viajo y no quedo en ningun
  // sitio desde donde reaparecer.
  await enlaceDeTablero(page, sembrado.activo.name).click();
  await enElTablero(page, sembrado.activo.name);
  await expect(panel(page)).toHaveCount(0);

  // Y a mano: una URL que junta el otro tablero con una tarea del primero no abre
  // nada. El panel busca la tarea DENTRO del tablero mostrado (`ubicarEnVista`).
  const ajena = await idDeTarea(TITULO_ALTA);

  await page.goto(`/?tablero=${await idDeTablero(TABLERO_OTRO)}&tarea=${ajena}`);
  await enElTablero(page, TABLERO_OTRO);
  await expect(panel(page)).toHaveCount(0);
});

// --- 6. EL QUE DECIDE: nada devuelve al primero -----------------------------

test("en un tablero que no es el primero, filtrar y abrir y cerrar el panel no devuelven al primero", async ({
  page,
  sembrado,
}) => {
  const otro = tableroSembrado(sembrado.semilla, TABLERO_OTRO);
  const id = await idDeTablero(TABLERO_OTRO);
  /** La URL de ESTE tablero, con cualquier cosa detras. */
  const enElOtro = new RegExp(`/\\?tablero=${id}(&|$)`, "u");

  await enlaceDeTablero(page, TABLERO_OTRO).click();
  await enElTablero(page, TABLERO_OTRO);

  // FILTRAR. El chip encendido es la senal de que llego el arbol nuevo.
  await filtro(page, "Alta").click();
  await expect(filtroPuesto(page, "Alta")).toBeVisible();
  await enElTablero(page, TABLERO_OTRO);
  await esperarTitulos(page, [TITULO_OTRO_ALTA]);
  await expect(page).toHaveURL(enElOtro);

  // QUITAR LOS FILTROS, que es otro enlace.
  await page.getByRole("link", { name: "Quitar filtros" }).click();
  await expect(filtro(page, "Alta")).toBeVisible();
  await enElTablero(page, TABLERO_OTRO);
  await esperarTitulos(page, titulosSembrados(otro));
  await expect(page).toHaveURL(enElOtro);

  // ABRIR EL PANEL desde una tarjeta, que es otro enlace mas.
  await tarjeta(page, TITULO_OTRO_MEDIA).click();
  await expect(panel(page)).toBeVisible();
  await expect(campoDelPanel(page, "Titulo")).toHaveValue(TITULO_OTRO_MEDIA);
  await enElTablero(page, TABLERO_OTRO);
  await expect(page).toHaveURL(enElOtro);

  // CERRARLO CON EL ENLACE: `hrefCerrar`, armado en la pagina.
  await panel(page).getByRole("link", { name: "Cerrar el detalle" }).click();
  await expect(panel(page)).toHaveCount(0);
  await enElTablero(page, TABLERO_OTRO);
  await esperarTitulos(page, titulosSembrados(otro));
  await expect(page).toHaveURL(enElOtro);

  // Y CON ESCAPE, que es el camino de CLIENTE: `router.push` con la misma cadena.
  await tarjeta(page, TITULO_OTRO_MEDIA).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(panel(page)).toHaveCount(0);
  await enElTablero(page, TABLERO_OTRO);
  await esperarTitulos(page, titulosSembrados(otro));
  await expect(page).toHaveURL(enElOtro);
});

// --- 7. Nombre invalido -----------------------------------------------------

test("un nombre vacio o de mas de 120 caracteres muestra el error y no crea nada", async ({
  page,
  sembrado,
}) => {
  const nombres = sembrado.semilla.tableros.map((tablero) => tablero.name);
  const campo = campoNuevoTablero(page);
  const aviso = errorNuevoTablero(page);

  // VACIO: Enter sin escribir nada. A diferencia del QuickAdd, aca dice que falta
  // (ver `NuevoTablero`).
  await campo.press("Enter");
  await expect(aviso).toHaveText("Escribi un nombre para crear el tablero.");
  await expect(campo).toHaveAttribute("aria-invalid", "true");

  // El aviso se va al tocar el campo...
  await campo.fill("  \t ");
  await expect(aviso).toHaveCount(0);

  // ...y SOLO BLANCOS cuenta como vacio.
  await campo.press("Enter");
  await expect(aviso).toHaveText("Escribi un nombre para crear el tablero.");

  // DEMASIADO LARGO: el mensaje es el del dominio, con la longitud y el tope.
  await campo.fill(NOMBRE_LARGUISIMO);
  await campo.press("Enter");
  await expect(aviso).toContainText("121");
  await expect(aviso).toContainText("120");

  // Y lo escrito se conserva, que es lo que el mensaje pide recortar.
  await expect(campo).toHaveValue(NOMBRE_LARGUISIMO);

  // No se creo nada, ni en la barra ni en la base, y la pantalla no se movio.
  await expect(itemsDeLaBarra(page)).toHaveText(nombres);
  await enElTablero(page, sembrado.activo.name);
  expect(await nombresDeTablerosEnLaBase()).toEqual(nombres);

  // Escape descarta lo escrito y el aviso, sin crear.
  await campo.press("Escape");
  await expect(campo).toHaveValue("");
  await expect(aviso).toHaveCount(0);
});

// --- Un tablero pedido que no existe ----------------------------------------

test("un tablero pedido que no existe lo dice, no muestra otro en su lugar y deja elegir", async ({
  page,
  sembrado,
}) => {
  const nombres = sembrado.semilla.tableros.map((tablero) => tablero.name);

  // Un UUID valido que no es de ningun tablero: el enlace a uno que se borro.
  const respuesta = await page.goto("/?tablero=00000000-0000-4000-8000-000000000000");

  // Ni 404 ni 500.
  expect(respuesta?.status()).toBe(200);
  await expect(avisoSinTablero(page)).toContainText("Ese tablero no existe");

  // NO CAE AL PRIMERO: no hay cabecera, ni columnas, ni item marcado.
  await expect(nombreDelTablero(page)).toHaveCount(0);
  await expect(page.locator(".columna")).toHaveCount(0);
  await expect(tableroMarcado(page)).toHaveCount(0);

  // Pero la barra esta, con todos, que es desde donde se sale.
  await expect(itemsDeLaBarra(page)).toHaveText(nombres);

  // Algo que ni es un UUID: no llega a la base, asi que tampoco puede dar 500.
  expect((await page.goto("/?tablero=cualquier-cosa"))?.status()).toBe(200);
  await expect(avisoSinTablero(page)).toContainText("Ese tablero no existe");

  await enlaceDeTablero(page, TABLERO_OTRO).click();
  await enElTablero(page, TABLERO_OTRO);
  await expect(avisoSinTablero(page)).toHaveCount(0);
});
