import { prefijoDe } from "@taskman/core";

import {
  crearPorLaApi,
  densa,
  emitirClaveParaLaApi,
  idDeTablero,
  moverPorElRegistroMcp,
  moverPorMcpRemoto,
  movimientosDeTarea,
  positionsDe,
  columnaEnLaBase,
} from "./base";
import {
  columnaDe,
  TITULO_ALTA,
  TITULO_BAJA,
  TITULO_CORTO,
  TITULO_LARGO,
  TITULO_MEDIA,
  TITULO_URGENTE,
  TITULO_VENCE_HOY,
  TITULO_VENCIDA_FUERA,
} from "./semilla";
import {
  agarrar,
  arrastrar,
  campoNuevaTarea,
  esperarEscuchando,
  expect,
  mirar,
  tarjeta,
  tarjetasDe,
  llevarA,
  soltar,
  tarjetasMarcadas,
  test,
  titulosMarcados,
} from "./tablero";

/**
 * QUE UN CAMBIO AJENO SE VEA, Y SE VEA COMO TAL: CT-06 y CT-07 de la 10.2, mas
 * la distincion por `actor_type` de la 7.4.
 *
 * SON DOS PROBLEMAS Y SE PRUEBAN COMO DOS. Enterarse —que la tarjeta aparezca
 * sin recargar— y mostrarlo —que se vea distinta de lo que hizo el usuario—. El
 * primero puede funcionar con el segundo roto y al reves, asi que ninguna prueba
 * de aca afirma las dos cosas a la vez sin nombrarlas por separado.
 *
 * NINGUNA RECARGA. Es lo que distingue estas pruebas de las del arrastre: se
 * marca el documento antes del cambio ajeno y se comprueba que la marca
 * sobrevive, o sea que la pantalla se actualizo SOLA. Sin eso, "aparecio" no
 * distingue el flujo de eventos de un `location.reload()` encubierto, que es
 * justamente lo que este paso vino a evitar.
 */

const BACKLOG = "Backlog";
const POR_HACER = "Por hacer";
const EN_PROGRESO = "En progreso";

/** Lo que crea la API en CT-06, y lo que crea la UI para contrastar en el caso 3. */
const TITULO_DE_LA_API = "Tarea creada por un cliente REST";
const TITULO_DE_LA_UI = "Tarea escrita por el usuario";

/**
 * Marca el documento. Si la pantalla se actualizara recargando, la marca se
 * iria con el documento viejo. Es el mismo truco que usa `quick-add.spec.ts`.
 */
async function marcarDocumento(page: import("@playwright/test").Page): Promise<void> {
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

/** Los titulos de una columna, como localizador (reintenta). */
function titulos(page: import("@playwright/test").Page, nombreColumna: string) {
  return tarjetasDe(page, nombreColumna).locator(".tarjeta__titulo");
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
  // Todas las pruebas de este archivo provocan un cambio AJENO, asi que todas
  // necesitan que el tablero ya este escuchando. Ver `esperarEscuchando`.
  await esperarEscuchando(page);
});

// --- 1. CT-06: crear por la API con la pantalla abierta ---------------------

test("CT-06: una tarea creada por la API aparece sin recargar a mano", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);

  await expect(titulos(page, POR_HACER)).toHaveText(sembradas);
  await marcarDocumento(page);

  // Un cliente REST cualquiera, con su clave y su scope (7.2). No es la UI: la
  // UI no consume su propia API publica (9.1).
  const clave = await emitirClaveParaLaApi(["WRITE"]);

  await crearPorLaApi({
    base: test.info().project.use.baseURL ?? "",
    clave,
    boardId: await idDeTablero(),
    columnKey: "TODO",
    title: TITULO_DE_LA_API,
  });

  // APARECE SOLA. El plazo por defecto de las aserciones (5 s) es el margen; en
  // la practica llega en el mismo instante en que commitea la transaccion.
  await expect(titulos(page, POR_HACER)).toHaveText([...sembradas, TITULO_DE_LA_API]);

  // Y SIN RECARGAR: el documento es el mismo que antes de la peticion.
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // El recuento de la cabecera sale del agregado de la base, no de contar
  // tarjetas: que cambie prueba que el servidor volvio a renderizar de verdad.
  await expect(
    page.getByRole("region", { name: POR_HACER, exact: true }).locator(".columna__recuento"),
  ).toHaveText(String(sembradas.length + 1));
});

// --- 2. CT-07: mover por MCP con la pantalla abierta ------------------------

/**
 * POR /mcp, CON EL CLIENTE DE LA SDK. Hasta el paso 8 de F4 este caso llamaba al
 * handler del registro sin transporte: cumplia la letra de la 10.2 —"via MCP"—
 * pero no pasaba por nada de lo que un cliente remoto atraviesa. Ahora recorre la
 * ruta real del servidor que levanto Playwright: red, initialize, clave Bearer,
 * scopes, cupo y montaje.
 *
 * Las pruebas 4 y 5 de este archivo siguen moviendo por el registro directo
 * (`moverPorElRegistroMcp`), y es a proposito: miden la pantalla, no el
 * transporte, y si /mcp se rompe tiene que caer ESTA y no todas.
 */
test("CT-07: una tarea movida por /mcp con el cliente de la SDK se refleja en el tablero sin recargar", async ({
  page,
}) => {
  await expect(titulos(page, EN_PROGRESO)).toHaveText(["Montar Playwright"]);
  await marcarDocumento(page);

  // La clave de un agente, con los scopes que la 7.2 recomienda darle: sin delete.
  const clave = await emitirClaveParaLaApi(["READ", "WRITE"]);

  await moverPorMcpRemoto({
    base: test.info().project.use.baseURL ?? "",
    clave,
    tarea: "Montar Playwright",
    aColumna: "BACKLOG",
    position: 0,
  });

  await expect(titulos(page, BACKLOG)).toHaveText([
    "Montar Playwright",
    TITULO_MEDIA,
    TITULO_URGENTE,
    TITULO_ALTA,
    TITULO_BAJA,
  ]);
  await expect(titulos(page, EN_PROGRESO)).toHaveText([]);
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // Llega como cambio AJENO: el actor que /mcp registra es AGENT.
  await expect(titulosMarcados(page)).toHaveText(["Montar Playwright"]);

  // Y en la base quedo denso, que es lo que no se ve en pantalla.
  const backlog = await columnaEnLaBase(BACKLOG);

  expect(positionsDe(backlog)).toEqual(densa(5));

  // LA HUELLA DE QUE PASO POR /mcp: AGENT con la etiqueta de la clave y su
  // prefijo como client_id. Por el registro directo el client_id seria NULL.
  expect(await movimientosDeTarea("Montar Playwright")).toEqual([
    { actorType: "AGENT", actorName: "clave de extremo a extremo", clientId: prefijoDe(clave) },
  ]);
});

// --- 3. Lo ajeno se ve distinto de lo propio --------------------------------

/**
 * LOS DOS CASOS EN LA MISMA PRUEBA, que es lo que pide el criterio: una tarea
 * creada por el USUARIO y otra por la API, y solo la segunda marcada.
 *
 * En dos pruebas separadas cada mitad podria pasar por el motivo equivocado —una
 * que marque TODO pasa la mitad "lo ajeno se marca", y una que no marque NADA
 * pasa la mitad "lo propio no se marca"— y juntas no dejan ninguna de las dos
 * salidas.
 *
 * EL ORDEN IMPORTA y no es casual: primero la UI, despues la API. Crear desde la
 * UI se teclea, y teclear ES una señal de que el usuario esta delante, o sea que
 * apagaria las marcas que ya hubiera (ver `lib/usar-mirada.ts`). Al reves, la
 * prueba estaria midiendo el apagado sin querer.
 */
test("lo que cambia un agente se marca; lo que hace el usuario en la misma pantalla no", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);

  // Nada marcado al cargar: el tablero recien leido no tiene nada "nuevo".
  await expect(tarjetasMarcadas(page)).toHaveCount(0);

  // (a) EL USUARIO crea una tarea desde el QuickAdd.
  const campo = campoNuevaTarea(page, POR_HACER);

  await campo.fill(TITULO_DE_LA_UI);
  await campo.press("Enter");
  await expect(titulos(page, POR_HACER)).toHaveText([...sembradas, TITULO_DE_LA_UI]);

  // No se marca: es suya, y realzarle al usuario lo que acaba de hacer
  // convertiria la señal en ruido permanente.
  await expect(tarjetasMarcadas(page)).toHaveCount(0);

  // (b) UN CLIENTE REST crea otra.
  const clave = await emitirClaveParaLaApi(["WRITE"]);

  await crearPorLaApi({
    base: test.info().project.use.baseURL ?? "",
    clave,
    boardId: await idDeTablero(),
    columnKey: "TODO",
    title: TITULO_DE_LA_API,
  });

  await expect(titulos(page, POR_HACER)).toHaveText([
    ...sembradas,
    TITULO_DE_LA_UI,
    TITULO_DE_LA_API,
  ]);

  // SOLO LA SEGUNDA lleva la marca. Las dos estan en la misma columna, se
  // crearon con segundos de diferencia y se ven igual salvo por esto.
  await expect(titulosMarcados(page)).toHaveText([TITULO_DE_LA_API]);
  await expect(tarjeta(page, TITULO_DE_LA_UI)).not.toHaveClass(/tarjeta--ajena/);

  // La marca es visible de verdad y no solo una clase en el atributo: el fondo
  // calculado de la tarjeta ajena difiere del de la propia.
  const ajena = await tarjeta(page, TITULO_DE_LA_API).evaluate(
    (nodo) => getComputedStyle(nodo).backgroundColor,
  );
  const propia = await tarjeta(page, TITULO_DE_LA_UI).evaluate(
    (nodo) => getComputedStyle(nodo).backgroundColor,
  );

  expect(ajena).not.toBe(propia);
});

// --- 4. La marca se apaga cuando el usuario mira ----------------------------

/**
 * "HASTA QUE EL USUARIO LA MIRE" = la pestaña visible mas la primera señal de
 * que hay alguien delante. El porque de esa definicion —y por que no
 * `visibilitychange`, ni el foco, ni un temporizador— esta en
 * `lib/usar-mirada.ts`.
 *
 * La prueba comprueba las DOS mitades: que NO se apaga sola con el tiempo, y que
 * se apaga con la señal. La primera es la que importa: una marca que se apaga
 * sola deja el cambio invisible para quien vuelve un minuto despues, que es el
 * caso para el que existe.
 */
test("la marca aguanta hasta que el usuario da señales de estar delante", async ({ page }) => {
  await moverPorElRegistroMcp({ tarea: TITULO_VENCE_HOY, aColumna: "IN_PROGRESS", position: 0 });

  await expect(titulosMarcados(page)).toHaveText([TITULO_VENCE_HOY]);

  /**
   * NO SE APAGA SOLA. Un segundo entero sin tocar nada —mas de tres veces lo que
   * dura el desvanecido del realce— y la marca sigue puesta. Sin esta espera, un
   * apagado por temporizador pasaria la prueba igual.
   */
  await page.waitForTimeout(1_000);
  await expect(titulosMarcados(page)).toHaveText([TITULO_VENCE_HOY]);

  // Y AHORA SI: mover el puntero es la señal.
  await mirar(page);
  await expect(tarjetasMarcadas(page)).toHaveCount(0);

  // La tarjeta sigue donde la dejo el agente: apagar la marca no deshace nada.
  await expect(titulos(page, EN_PROGRESO)).toHaveText([TITULO_VENCE_HOY, "Montar Playwright"]);

  // Y un cambio ajeno posterior vuelve a marcar: el apagado no es definitivo.
  await moverPorElRegistroMcp({ tarea: TITULO_CORTO, aColumna: "BACKLOG", position: 0 });
  await expect(titulosMarcados(page)).toHaveText([TITULO_CORTO]);
});

// --- 5. El caso que puede morder: un cambio ajeno DURANTE un arrastre -------

/**
 * LOS DOS MECANISMOS TOCAN EL MISMO ESTADO. El arrastre del paso anterior manda
 * sobre el orden local mientras dura el gesto y hasta que responde la accion; el
 * refresco de este paso reemplaza ese orden con lo que diga el servidor. Si el
 * refresco cae en medio, la tarjeta agarrada vuelve a su sitio o —peor— la
 * reconciliacion del punto 3 de la 9.2 corrige contra un estado que ya no es el
 * que calculo el navegador.
 *
 * COMO SE MONTA: un agente mueve OTRA tarea justo antes de soltar, con el gesto
 * ya empezado. El aviso llega mientras `activa` no es nula, asi que se encola; se
 * aplica cuando el tablero queda quieto.
 *
 * QUE SE AFIRMA: que el arrastre termina donde el usuario lo dejo, que el cambio
 * del agente NO se perdio —se aplico despues, con su marca— y que la base tiene
 * los dos movimientos con las columnas densas.
 */
test("un cambio ajeno durante un arrastre no rompe la reconciliacion y no se pierde", async ({
  page,
}) => {
  await expect(titulos(page, BACKLOG)).toHaveText([
    TITULO_MEDIA,
    TITULO_URGENTE,
    TITULO_ALTA,
    TITULO_BAJA,
  ]);

  /**
   * El agente escribe DESPUES de agarrar y ANTES de soltar, asi que el gesto se
   * abre y se cierra por partes en vez de con `arrastrar`, que hace las tres de
   * una. Las flechas las sigue contando el ayudante: pulsarlas aca a mano se
   * come la espera de fotograma y el movimiento sale corto (paso una vez, y solo
   * con la maquina cargada).
   */
  await agarrar(page, TITULO_MEDIA);

  // Con la tarjeta agarrada, un agente mueve otra de otra columna.
  await moverPorElRegistroMcp({ tarea: TITULO_LARGO, aColumna: "IN_PROGRESS", position: 0 });

  // El aviso llego y NO se aplico: la tarjeta que movio el agente sigue donde
  // estaba, porque refrescar ahora romperia el gesto en curso.
  await expect(titulos(page, POR_HACER)).toHaveText([
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ]);

  // Se completa el arrastre: la tarjeta baja al tercer lugar del Backlog.
  await llevarA(page, TITULO_MEDIA, { columna: BACKLOG, indice: 2 });
  await soltar(page);

  // EL ARRASTRE TERMINO DONDE EL USUARIO LO DEJO.
  const backlogEsperado = [TITULO_URGENTE, TITULO_ALTA, TITULO_MEDIA, TITULO_BAJA];

  await expect(titulos(page, BACKLOG)).toHaveText(backlogEsperado);

  // Y EL CAMBIO DEL AGENTE SE APLICO DESPUES, con su marca.
  await expect(titulos(page, EN_PROGRESO)).toHaveText([TITULO_LARGO, "Montar Playwright"]);
  await expect(titulosMarcados(page)).toHaveText([TITULO_LARGO]);

  // La reconciliacion no tuvo que corregir nada: el agente movio OTRA tarea y de
  // OTRA columna, asi que el orden que calculo el navegador para el Backlog era
  // el correcto. Un 1 aca significaria que el refresco se colo en medio.
  await expect(page.locator(".columnas")).toHaveAttribute("data-correcciones", "0");

  // Las tres columnas afectadas, densas y con los dos movimientos aplicados.
  expect(positionsDe(await columnaEnLaBase(BACKLOG))).toEqual(densa(4));
  expect((await columnaEnLaBase(BACKLOG)).map((f) => f.title)).toEqual(backlogEsperado);
  expect(positionsDe(await columnaEnLaBase(EN_PROGRESO))).toEqual(densa(2));
  expect(positionsDe(await columnaEnLaBase(POR_HACER))).toEqual(densa(3));
});

// --- 6. Un movimiento propio no se marca a si mismo -------------------------

/**
 * El complemento del caso 3 para el ARRASTRE, que es la escritura mas visible de
 * la UI: mover una tarjeta uno mismo no puede dejarla realzada como si la
 * hubiera movido otro. Es el fallo mas facil de introducir —el aviso por
 * `/eventos` llega igual, con actor USER— y el que convertiria el realce en ruido
 * permanente.
 */
test("arrastrar una tarjeta uno mismo no la deja marcada", async ({ page }) => {
  await arrastrar(page, TITULO_URGENTE, { columna: POR_HACER, indice: "principio" });

  await expect(titulos(page, POR_HACER)).toHaveText([
    TITULO_URGENTE,
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ]);

  // Ni la movida ni ninguna otra: la reescritura del orden toca varias filas de
  // la base, pero una sola fila de auditoria, y es propia.
  await expect(tarjetasMarcadas(page)).toHaveCount(0);
});
