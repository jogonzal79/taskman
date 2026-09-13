import {
  columnaDe,
  DESCRIPCION_DE_CONTRATO,
  TITULO_MEDIA,
  TITULO_URGENTE,
  TITULO_VENCIDA_FUERA,
} from "./semilla";
import {
  campoDelPanel,
  columna,
  estiloCalculado,
  expect,
  panel,
  tarjeta,
  tarjetasDe,
  test,
} from "./tablero";

/**
 * TaskDetailPanel (9.3): abrir una tarjeta, editar sus campos al perder el foco,
 * y borrar.
 *
 * Cubre los casos 1, 2, 5 y 7 del paso. Los que van por SQL en el reporte —que
 * vaciar la descripcion la deje en NULL, que no tocarla la conserve, la fecha sin
 * corrimiento de dia y la ausencia de auditoria cuando no hay cambio efectivo—
 * NO estan aca, y no por comodidad: una descripcion vacia y una NULL se pintan
 * EXACTAMENTE igual en el campo, asi que una prueba de navegador no puede
 * distinguirlas. Afirmar por pantalla lo que solo se ve en la base seria escribir
 * una prueba que pasa en los dos casos.
 *
 * Como en las de QuickAdd, ninguna recarga: se marca `window` y se comprueba que
 * la marca sobrevive, o sea que lo que cambio la pantalla fue la revalidacion y
 * no una carga de documento.
 */

async function marcar(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mismoDocumento?: boolean }).__mismoDocumento = true;
  });
}

async function sigueElMismoDocumento(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __mismoDocumento?: boolean }).__mismoDocumento === true,
  );
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

// --- 1. Abrir muestra los datos; Escape cierra ------------------------------

test("abrir una tarjeta muestra sus datos y Escape cierra el panel", async ({ page, sembrado }) => {
  const { hoy } = sembrado;

  // Sin panel hasta que se abre uno: el parametro de consulta no esta.
  await expect(panel(page)).toHaveCount(0);

  await marcar(page);
  await tarjeta(page, TITULO_VENCIDA_FUERA).click();

  await expect(panel(page)).toBeVisible();

  // Los cuatro campos editables de la 5.2, con los valores sembrados.
  await expect(campoDelPanel(page, "Titulo")).toHaveValue(TITULO_VENCIDA_FUERA);
  await expect(campoDelPanel(page, "Descripcion")).toHaveValue(
    "Hay que contestarle antes del viernes.",
  );
  await expect(campoDelPanel(page, "Prioridad")).toHaveValue("MEDIUM");

  // La fecha, en `AAAA-MM-DD` y SIN corrimiento: la sembrada es hoy menos tres
  // dias leidos en UTC. Es la misma comprobacion que el caso 4 hace por SQL, y
  // aca mira el otro extremo del viaje —lo que el navegador muestra— porque el
  // corrimiento de un dia se puede introducir en cualquiera de los dos.
  const esperada = new Date(
    Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - 3),
  )
    .toISOString()
    .slice(0, 10);
  await expect(campoDelPanel(page, "Fecha limite")).toHaveValue(esperada);

  // Dice de que columna es, y que para cambiarla hace falta otra operacion (5.2).
  await expect(panel(page)).toContainText("Por hacer");

  // La tarjeta abierta se distingue de las demas, para saber que se esta editando.
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).toHaveClass(/tarjeta--abierta/u);
  await expect(tarjeta(page, TITULO_MEDIA)).not.toHaveClass(/tarjeta--abierta/u);

  // Y el panel es LATERAL, no modal: el tablero sigue a la vista al lado.
  await expect(columna(page, "Backlog")).toBeVisible();
  await expect(tarjeta(page, TITULO_URGENTE)).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(panel(page)).toHaveCount(0);
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).not.toHaveClass(/tarjeta--abierta/u);
  expect(await sigueElMismoDocumento(page)).toBe(true);
});

// --- 2. Editar el titulo al perder el foco ----------------------------------

test("editar el titulo y salir del campo lo guarda y se ve en la tarjeta", async ({
  page,
  sembrado,
}) => {
  const backlog = columnaDe(sembrado.activo, "BACKLOG");
  const nuevo = "Revisar el contrato y el openapi.json";

  await marcar(page);
  await tarjeta(page, TITULO_MEDIA).click();

  const campo = campoDelPanel(page, "Titulo");
  await campo.fill(nuevo);

  // Hasta que no pierde el foco NO se guarda: no hay boton, el blur es el gesto
  // (9.3). Comprobarlo es lo que distingue "guardado al perder el foco" de
  // "guardado al teclear".
  await expect(tarjeta(page, TITULO_MEDIA)).toBeVisible();

  await campo.blur();

  // La tarjeta del TABLERO cambia, no solo el campo del panel: es lo que prueba
  // que la revalidacion repinto el arbol del servidor.
  await expect(tarjeta(page, nuevo)).toBeVisible();
  await expect(tarjeta(page, TITULO_MEDIA)).toHaveCount(0);

  // Y en su lugar, sin moverse: el titulo no cambia la position.
  const titulos = backlog.tareas.map((tarea) =>
    tarea.title === TITULO_MEDIA ? nuevo : tarea.title,
  );
  await expect(tarjetasDe(page, backlog.name).locator(".tarjeta__titulo")).toHaveText(titulos);

  // El panel sigue abierto sobre la misma tarea, con el valor nuevo.
  await expect(campoDelPanel(page, "Titulo")).toHaveValue(nuevo);
  await expect(tarjeta(page, nuevo)).toHaveClass(/tarjeta--abierta/u);

  expect(await sigueElMismoDocumento(page)).toBe(true);

  // Un titulo vacio NO borra el titulo —no es nullable— sino que lo rechaza el
  // nucleo, y el mensaje aparece en el panel.
  await campoDelPanel(page, "Titulo").fill("   ");
  await campoDelPanel(page, "Titulo").blur();

  await expect(panel(page).locator(".panel__error")).toContainText("title");
  await expect(tarjeta(page, nuevo)).toBeVisible();
});

// --- 3. Vaciar la descripcion la borra; no tocarla la conserva --------------

test("vaciar la descripcion la borra y no vuelve al recargar; editar otro campo la conserva", async ({
  page,
}) => {
  /**
   * ESTA ES LA UNICA PRUEBA DE ESTE ARCHIVO QUE RECARGA, y la recarga ES el
   * mecanismo. Sin ella no distingue nada: si vaciar el campo no mandara la
   * peticion —el colapso de tratar "vacio" igual que "no lo toque"— el campo se
   * veria vacio de todas formas, porque el que lo vacio fue el navegador y la
   * revalidacion no lo remonta si el valor del servidor no cambio. Recargar tira
   * ese estado local y obliga a que lo que se ve venga de la base.
   *
   * Lo que esta prueba NO puede ver, y por eso el caso se verifica ademas por
   * SQL: la diferencia entre NULL y cadena vacia. Las dos pintan un campo vacio.
   */
  await tarjeta(page, TITULO_VENCIDA_FUERA).click();

  const descripcion = campoDelPanel(page, "Descripcion");
  await expect(descripcion).toHaveValue("Hay que contestarle antes del viernes.");

  await descripcion.fill("");
  await descripcion.blur();
  await expect(campoDelPanel(page, "Descripcion")).toHaveValue("");

  await page.reload();
  await expect(campoDelPanel(page, "Descripcion")).toHaveValue("");

  // Y AL REVES: en otra tarea, editar un campo distinto deja la descripcion
  // donde estaba. Es la otra mitad de la distincion —ausente conserva— y sin
  // ella un `?? null` en el spread pasaria desapercibido: borraria la
  // descripcion cada vez que se guarda cualquier otro campo.
  await tarjeta(page, TITULO_MEDIA).click();
  await expect(campoDelPanel(page, "Descripcion")).toHaveValue(DESCRIPCION_DE_CONTRATO);

  const titulo = campoDelPanel(page, "Titulo");
  await titulo.fill("Revisar el contrato y su tabla");
  await titulo.blur();
  await expect(tarjeta(page, "Revisar el contrato y su tabla")).toBeVisible();

  await page.reload();
  await expect(campoDelPanel(page, "Descripcion")).toHaveValue(DESCRIPCION_DE_CONTRATO);
});

// --- 5. Cambiar la prioridad se refleja en la tarjeta -----------------------

test("una MEDIUM que pasa a URGENT gana etiqueta y borde en la tarjeta", async ({ page }) => {
  const media = tarjeta(page, TITULO_MEDIA);
  const yaUrgente = tarjeta(page, TITULO_URGENTE);

  // El punto de partida: sin chip, y con el borde neutro.
  await expect(media.locator(".prioridad")).toHaveCount(0);
  const bordeNeutro = await estiloCalculado(media, "border-left-color");
  const bordeUrgente = await estiloCalculado(yaUrgente, "border-left-color");
  expect(bordeNeutro).not.toBe(bordeUrgente);

  await marcar(page);
  await media.click();
  await campoDelPanel(page, "Prioridad").selectOption("URGENT");

  // Gana la etiqueta...
  await expect(media.locator(".prioridad")).toHaveText("Urgente");

  // ...y el borde, que es la senal que se ve sin leer la tarjeta. Se compara con
  // el de la que YA era urgente y no con un color escrito aca: lo que se afirma
  // es que las dos se pintan igual, no cual es el rojo de la hoja de estilo.
  await expect
    .poll(async () => estiloCalculado(media, "border-left-color"))
    .toBe(bordeUrgente);

  expect(await sigueElMismoDocumento(page)).toBe(true);
});

// --- 7. Borrar ---------------------------------------------------------------

test("borrar pide un segundo clic, quita la tarjeta del tablero y cierra el panel", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);

  await marcar(page);
  await tarjeta(page, TITULO_VENCIDA_FUERA).click();

  // PRIMER CLIC: arma y no borra. La confirmacion de esta superficie es un
  // segundo clic, no un parametro `confirm` como en la 8.3.2.
  await panel(page).getByRole("button", { name: "Borrar tarea" }).click();

  // El aviso nombra la tarea: es lo que convierte el segundo clic en una
  // decision sobre algo concreto.
  await expect(panel(page)).toContainText(TITULO_VENCIDA_FUERA);
  await expect(panel(page).getByRole("button", { name: "Si, borrar" })).toBeVisible();
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).toBeVisible();

  // Y se puede desarmar sin consecuencias.
  await panel(page).getByRole("button", { name: "Cancelar" }).click();
  await expect(panel(page).getByRole("button", { name: "Si, borrar" })).toHaveCount(0);
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).toBeVisible();

  // SEGUNDO CLIC de verdad.
  await panel(page).getByRole("button", { name: "Borrar tarea" }).click();
  await panel(page).getByRole("button", { name: "Si, borrar" }).click();

  // La tarjeta se va del tablero, el recuento baja y el panel se cierra: la
  // tarea ya no existe, asi que no hay nada que mostrar.
  await expect(tarjeta(page, TITULO_VENCIDA_FUERA)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(
    sembradas.filter((titulo) => titulo !== TITULO_VENCIDA_FUERA),
  );
  await expect(columna(page, porHacer.name).locator(".columna__recuento")).toHaveText(
    String(sembradas.length - 1),
  );

  expect(await sigueElMismoDocumento(page)).toBe(true);
});

// --- Un id que no apunta a nada no rompe la pagina --------------------------

test("un parametro de tarea que no existe dibuja el tablero sin panel", async ({
  page,
  sembrado,
}) => {
  const backlog = columnaDe(sembrado.activo, "BACKLOG");

  // Un UUID valido que no es de ninguna tarea. Es el caso de un enlace viejo, o
  // de una tarea que otro actor borro mientras estaba abierta: no es un error del
  // sistema y no puede terminar en 404 ni en 500.
  await page.goto("/?tarea=00000000-0000-4000-8000-000000000000");

  await expect(panel(page)).toHaveCount(0);
  await expect(tarjetasDe(page, backlog.name).locator(".tarjeta__titulo")).toHaveText(
    backlog.tareas.map((tarea) => tarea.title),
  );

  // Y un valor que no es ni un UUID tampoco: no se consulta nada con el, asi que
  // no hay forma de que llegue a la base.
  await page.goto("/?tarea=cualquier-cosa");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".columna__nombre")).toHaveCount(4);
});

