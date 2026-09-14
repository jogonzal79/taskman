import {
  borrarPorElNucleo,
  columnaEnLaBase,
  densa,
  moverPorElNucleo,
  positionsDe,
  titulosEnLaBase,
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
  TITULO_VENCIDA_EN_DONE,
  TITULO_VENCIDA_FUERA,
} from "./semilla";
import {
  anotarAnimaciones,
  arrastrar,
  arrastrarConRaton,
  arrastrarYCancelar,
  avisoDeMovimiento,
  columna,
  correcciones,
  cortarElFlujoDeCambios,
  esperarSordo,
  expect,
  filtroPuesto,
  panel,
  tarjeta,
  tarjetasAnimadas,
  tarjetasDe,
  test,
} from "./tablero";

/**
 * EL ARRASTRE (9.1) con la RECONCILIACION (9.2), y el CT-03 de la 10.2.
 *
 * COMO SE ARRASTRA EN ESTAS PRUEBAS: con el TECLADO, salvo en una. El porque
 * esta escrito en `arrastrar` (e2e/tablero.ts) y se resume en que un arrastre
 * con raton afirma sobre una geometria en pixeles que nadie declaro, mientras
 * que "agarrar y pulsar la flecha derecha" es una intencion discreta. El camino
 * que se ejercita es el MISMO: mismo `onDragEnd`, mismo estado optimista, misma
 * Server Action y misma reconciliacion. Lo unico que el teclado no toca es el
 * sensor de puntero, y para eso esta la ultima prueba del archivo.
 *
 * SE AFIRMA EN LOS DOS SITIOS, y no es redundancia. En la PANTALLA, que es lo
 * que la persona ve; y en la BASE por SQL, que es lo unico que puede decir que
 * el orden quedo DENSO 0..n-1 (ADR-004): un tablero que se ve perfecto es
 * compatible con positions 0, 1, 3, 7, y ese hueco no se paga hasta mucho
 * despues.
 *
 * CADA PRUEBA DECLARA LA INTENCION, no la mecanica: `arrastrar(page, titulo,
 * { columna, indice })`. Las flechas las cuenta el ayudante mirando el DOM, por
 * lo que explica su comentario en `tablero.ts`; contarlas a mano en la prueba no
 * es determinista y ademas convertiria cada prueba en una descripcion de la
 * geometria del tablero en vez de del movimiento.
 */

const BACKLOG = "Backlog";
const POR_HACER = "Por hacer";
const EN_PROGRESO = "En progreso";
const COMPLETADO = "Completado";

/** Los titulos que se ven en una columna, como localizador (reintenta). */
function titulos(page: import("@playwright/test").Page, nombreColumna: string) {
  return tarjetasDe(page, nombreColumna).locator(".tarjeta__titulo");
}

/**
 * Que la columna quede densa 0..n-1 en la base y con estos titulos en orden.
 *
 * ESPERA (`expect.poll`) en vez de leer una vez, y la razon es el paso entero:
 * la pantalla se reordena de INMEDIATO —punto 1 de la 9.2— y la transaccion
 * termina despues. Una lectura suelta justo despues de soltar corre contra el
 * commit y falla una de cada tantas veces, que es como se fabrica una prueba
 * intermitente. Lo que se afirma no es "ya esta escrito" sino "termina escrito".
 *
 * Las POSITIONS se comprueban en una lectura aparte y sin reintento, ya con el
 * orden estable: si estuvieran dentro del `poll` bastaria un intento con el
 * orden bueno y las positions malas para que el siguiente intento las tapara.
 */
async function esperarColumnaEnLaBase(
  nombreColumna: string,
  esperados: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => (await columnaEnLaBase(nombreColumna)).map((fila) => fila.title), {
      message: `titulos de "${nombreColumna}" en la base`,
    })
    .toEqual([...esperados]);

  // La mitad que no se ve en pantalla: sin huecos y empezando en cero.
  expect(positionsDe(await columnaEnLaBase(nombreColumna))).toEqual(densa(esperados.length));
}

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

// --- 1. Entre columnas ------------------------------------------------------

test("arrastrar entre columnas deja la tarea en la columna y posicion destino, con las dos columnas densas", async ({
  page,
  sembrado,
}) => {
  const backlog = columnaDe(sembrado.activo, "BACKLOG");
  const porHacer = columnaDe(sembrado.activo, "TODO");

  await expect(titulos(page, BACKLOG)).toHaveText(backlog.tareas.map((tarea) => tarea.title));

  // La urgente sale del medio del Backlog y entra arriba del todo en Por hacer.
  await arrastrar(page, TITULO_URGENTE, { columna: POR_HACER, indice: "principio" });

  const porHacerEsperado = [
    TITULO_URGENTE,
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ];
  const backlogEsperado = [TITULO_MEDIA, TITULO_ALTA, TITULO_BAJA];

  await expect(titulos(page, POR_HACER)).toHaveText(porHacerEsperado);
  await expect(titulos(page, BACKLOG)).toHaveText(backlogEsperado);

  // Y EN LA BASE. Las DOS columnas densas y el orden relativo del resto intacto:
  // en el Backlog, media-alta-baja siguen en ese orden con la urgente quitada
  // del medio; en Por hacer, las cuatro sembradas siguen en su orden con la
  // nueva delante.
  await esperarColumnaEnLaBase(POR_HACER, porHacerEsperado);
  await esperarColumnaEnLaBase(BACKLOG, backlogEsperado);

  // Las otras dos columnas no se tocaron.
  await esperarColumnaEnLaBase(EN_PROGRESO, ["Montar Playwright"]);
  await esperarColumnaEnLaBase(COMPLETADO, [TITULO_VENCIDA_EN_DONE, "Pasar a Turbopack"]);
});

test("arrastrar a una columna con una sola tarea, al final", async ({ page }) => {
  await arrastrar(page, TITULO_BAJA, { columna: EN_PROGRESO, indice: "final" });

  await expect(titulos(page, EN_PROGRESO)).toHaveText(["Montar Playwright", TITULO_BAJA]);
  await esperarColumnaEnLaBase(EN_PROGRESO, ["Montar Playwright", TITULO_BAJA]);
  await esperarColumnaEnLaBase(BACKLOG, [TITULO_MEDIA, TITULO_URGENTE, TITULO_ALTA]);
});

// --- 2. Dentro de la misma columna, hacia adelante y hacia atras -------------

test("arrastrar dentro de la misma columna, adelante y atras", async ({ page }) => {
  // HACIA ADELANTE: la primera baja dos lugares.
  await arrastrar(page, TITULO_MEDIA, { columna: BACKLOG, indice: 2 });

  const trasBajar = [TITULO_URGENTE, TITULO_ALTA, TITULO_MEDIA, TITULO_BAJA];

  await expect(titulos(page, BACKLOG)).toHaveText(trasBajar);
  await esperarColumnaEnLaBase(BACKLOG, trasBajar);

  // HACIA ATRAS: la ultima sube hasta arriba del todo. No es el mismo camino en
  // el nucleo —el indice pedido no se ajusta igual segun de donde salga la
  // tarea— asi que las dos direcciones son dos casos y no uno.
  await arrastrar(page, TITULO_BAJA, { columna: BACKLOG, indice: "principio" });

  const trasSubir = [TITULO_BAJA, TITULO_URGENTE, TITULO_ALTA, TITULO_MEDIA];

  await expect(titulos(page, BACKLOG)).toHaveText(trasSubir);
  await esperarColumnaEnLaBase(BACKLOG, trasSubir);

  // Ninguna otra columna se movio por un reordenamiento interno.
  await esperarColumnaEnLaBase(POR_HACER, [
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ]);
});

// --- 3. CT-03: arrastrar, RECARGAR, y que persista --------------------------

test("CT-03: la columna y la posicion sobreviven a un recargado", async ({ page }) => {
  await arrastrar(page, TITULO_VENCE_HOY, { columna: BACKLOG, indice: "principio" });

  const backlogEsperado = [
    TITULO_VENCE_HOY,
    TITULO_MEDIA,
    TITULO_URGENTE,
    TITULO_ALTA,
    TITULO_BAJA,
  ];

  await expect(titulos(page, BACKLOG)).toHaveText(backlogEsperado);

  /**
   * LA RECARGA ES EL PUNTO DEL CT-03. Sin ella, esta prueba solo diria que el
   * estado optimista del navegador se pinto: un tablero que se reordena en
   * pantalla y no escribe nada pasaria igual. Con documento nuevo, lo que se ve
   * sale de la base por el camino de lectura del Server Component.
   */
  await page.reload();

  await expect(titulos(page, BACKLOG)).toHaveText(backlogEsperado);
  await expect(titulos(page, POR_HACER)).toHaveText([
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
  ]);

  await esperarColumnaEnLaBase(BACKLOG, backlogEsperado);
  await esperarColumnaEnLaBase(POR_HACER, [TITULO_LARGO, TITULO_CORTO, TITULO_VENCIDA_FUERA]);
});

// --- 4. Con un filtro puesto ------------------------------------------------

/**
 * CON FILTRO, EL INDICE VISIBLE NO ES LA POSITION, y esta prueba esta montada
 * exactamente sobre esa diferencia.
 *
 * Con `?prioridad=LOW`, Completado muestra UNA tarjeta ("Pasar a Turbopack",
 * position 1) y esconde la que esta en la position 0. Soltar la tarea de baja
 * prioridad JUSTO ENCIMA de la que se ve tiene que dejarla en la position 1
 * —entre la escondida y la visible— y no en la 0, que es donde la mandaria
 * quien confundiera el indice de la pantalla con el de la columna. Las dos
 * cuentas dan una pantalla identica; solo el SQL las distingue.
 */
test("con un filtro puesto, arrastrar funciona, respeta lo que el filtro esconde y no pierde el filtro", async ({
  page,
}) => {
  await page.goto("/?prioridad=LOW");

  await expect(titulos(page, BACKLOG)).toHaveText([TITULO_BAJA]);
  await expect(titulos(page, COMPLETADO)).toHaveText(["Pasar a Turbopack"]);

  await arrastrar(page, TITULO_BAJA, { columna: COMPLETADO, indice: "principio" });

  // En pantalla, encima de la unica que se veia.
  await expect(titulos(page, COMPLETADO)).toHaveText([TITULO_BAJA, "Pasar a Turbopack"]);
  await expect(titulos(page, BACKLOG)).toHaveText([]);

  // Y EN LA BASE, DEBAJO de la que el filtro escondia: la position es 1 y no 0.
  await esperarColumnaEnLaBase(COMPLETADO, [
    TITULO_VENCIDA_EN_DONE,
    TITULO_BAJA,
    "Pasar a Turbopack",
  ]);
  await esperarColumnaEnLaBase(BACKLOG, [TITULO_MEDIA, TITULO_URGENTE, TITULO_ALTA]);

  // EL FILTRO SIGUE PUESTO: ni la URL ni el chip lo perdieron. Un movimiento no
  // navega, asi que la revalidacion vuelve a renderizar ESTA misma URL.
  expect(new URL(page.url()).search).toBe("?prioridad=LOW");
  await expect(filtroPuesto(page, "Baja")).toBeVisible();

  // Y lo que el filtro esconde sigue escondido despues del movimiento.
  await expect(titulos(page, COMPLETADO)).not.toContainText([TITULO_VENCIDA_EN_DONE]);
});

// --- Cancelar a mitad de camino ---------------------------------------------

/**
 * ESCAPE DESHACE TAMBIEN LO QUE SE VEIA.
 *
 * La tarjeta cambia de columna MIENTRAS se arrastra (`onDragOver`), o sea que en
 * el momento de pulsar Escape el estado local ya tiene medio movimiento
 * aplicado. Si la cancelacion no lo revirtiera, la pantalla se quedaria
 * mostrando la tarea en una columna en la que no esta, y sin ningun error: es la
 * misma mentira que el punto 4 de la 9.2 evita cuando la accion falla, pero por
 * un camino que no pasa por el servidor.
 */
test("Escape a mitad del arrastre devuelve la tarjeta a su columna y no escribe nada", async ({
  page,
}) => {
  const backlogSembrado = [TITULO_MEDIA, TITULO_URGENTE, TITULO_ALTA, TITULO_BAJA];
  const porHacerSembrado = [
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ];

  await arrastrarYCancelar(page, TITULO_URGENTE, POR_HACER);

  await expect(titulos(page, BACKLOG)).toHaveText(backlogSembrado);
  await expect(titulos(page, POR_HACER)).toHaveText(porHacerSembrado);
  await expect(avisoDeMovimiento(page)).toHaveCount(0);

  // Y en la base no se escribio nada: las dos columnas como se sembraron.
  await esperarColumnaEnLaBase(BACKLOG, backlogSembrado);
  await esperarColumnaEnLaBase(POR_HACER, porHacerSembrado);
});

// --- 5. El punto 4 de la 9.2: la accion falla -------------------------------

/**
 * COMO SE FUERZA EL FALLO: un agente BORRA la tarea por el nucleo mientras la
 * pantalla la sigue mostrando. La pagina no consulta sola, asi que la tarjeta
 * sigue ahi y se puede arrastrar; al soltarla, `TaskService.move` no encuentra
 * la fila y lanza TASK_NOT_FOUND.
 *
 * Se elige este y no un doble ni una ruta de prueba porque es un fallo REAL del
 * sistema —el caso de dos actores sobre el mismo tablero, que es para lo que
 * existe este producto— y porque recorre el camino entero: error de dominio,
 * Server Action que lo DEVUELVE en vez de lanzarlo, y componente que lo pinta.
 */
test("si la accion falla, el tablero vuelve al estado previo y se ve el mensaje", async ({
  page,
}) => {
  const backlogSembrado = [TITULO_MEDIA, TITULO_URGENTE, TITULO_ALTA, TITULO_BAJA];

  /**
   * CON EL FLUJO DE CAMBIOS CORTADO, porque el montaje lo exige: hace falta que
   * la pantalla siga mostrando una tarjeta que ya no existe. Con el flujo vivo,
   * el borrado del agente llega en el acto y la tarjeta desaparece antes de
   * poder arrastrarla, o sea que no habria forma de provocar el TASK_NOT_FOUND.
   *
   * Es la condicion realista para este fallo, ademas: lo que se prueba es que un
   * tablero DESACTUALIZADO no escribe mentiras, y hoy la forma de estar
   * desactualizado es no estar escuchando.
   */
  await cortarElFlujoDeCambios(page);
  await page.reload();
  await esperarSordo(page);

  await expect(titulos(page, BACKLOG)).toHaveText(backlogSembrado);

  // Otro actor la borra. La pantalla no se entera.
  await borrarPorElNucleo(TITULO_ALTA);
  await expect(tarjeta(page, TITULO_ALTA)).toBeVisible();

  await arrastrar(page, TITULO_ALTA, { columna: POR_HACER, indice: "principio" });

  // EL MENSAJE ES EL DEL DOMINIO, no uno generico: "No existe la tarea <id>".
  const aviso = avisoDeMovimiento(page);

  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("No existe la tarea");

  // Y EL TABLERO VUELVE AL ESTADO PREVIO: la tarjeta esta donde estaba, no en la
  // columna destino. Es el punto 4 entero: la instantanea se restaura.
  await expect(titulos(page, BACKLOG)).toHaveText(backlogSembrado);
  await expect(titulos(page, POR_HACER)).toHaveText([
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ]);

  // En la base no quedo nada a medias: Por hacer sigue como se sembro y el
  // Backlog tiene las tres que sobrevivieron al borrado, densas.
  await esperarColumnaEnLaBase(POR_HACER, [
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
  ]);
  await esperarColumnaEnLaBase(BACKLOG, [TITULO_MEDIA, TITULO_URGENTE, TITULO_BAJA]);
});

// --- 6. LA RECONCILIACION: el orden del servidor gana -----------------------

/**
 * EL CRITERIO QUE DECIDE EL PASO: montar un caso en el que el orden que devuelve
 * el servidor NO sea el que calculo el navegador, y comprobar que la pantalla
 * termina con el del SERVIDOR.
 *
 * COMO SE MONTA. La pantalla carga Por hacer como [LARGO, CORTO, VENCIDA, HOY].
 * Un agente mueve HOY —la ultima— hasta arriba por el nucleo, sin pasar por el
 * navegador, asi que en la base la columna pasa a ser [HOY, LARGO, CORTO,
 * VENCIDA] mientras la pantalla sigue mostrando la de antes. Entonces se
 * arrastra LARGO hasta abajo del todo:
 *
 *   - EL NAVEGADOR calcula sobre lo que ve: sacar LARGO de [LARGO, CORTO,
 *     VENCIDA, HOY] y ponerlo al final da [CORTO, VENCIDA, HOY, LARGO], y pide
 *     la position del vecino de arriba (HOY, que el cree en la 3) mas uno: 3.
 *   - EL SERVIDOR aplica esa position sobre la columna REAL: sacar LARGO de
 *     [HOY, LARGO, CORTO, VENCIDA] deja [HOY, CORTO, VENCIDA] e insertar en 3 da
 *     [HOY, CORTO, VENCIDA, LARGO].
 *
 * Los dos ordenes DIFIEREN —HOY esta primero en uno y tercero en el otro— y ese
 * es el punto: sin el paso 3 de la 9.2 la pantalla se quedaria con el suyo, que
 * es el que NO esta en la base, y el error solo se veria al recargar.
 *
 * QUE SE AFIRMA, en este orden: que la reconciliacion CORRIGIO (el contador
 * `data-correcciones`, que es lo unico que distingue "corrigio" de "no hizo
 * falta"), que la pantalla quedo con el orden del SERVIDOR, y que ese orden es
 * de verdad el de la base.
 */
test("cuando el servidor contradice al navegador, la pantalla termina con el orden del servidor", async ({
  page,
}) => {
  const comoSeVeAlCargar = [TITULO_LARGO, TITULO_CORTO, TITULO_VENCIDA_FUERA, TITULO_VENCE_HOY];

  // Se anota cada animacion desde antes de que cargue nada; ver `anotarAnimaciones`.
  await anotarAnimaciones(page);
  /**
   * Y SE CORTA EL FLUJO DE CAMBIOS. Sin esto no hay divergencia que reconciliar:
   * el movimiento del agente llegaria por `/eventos`, la pantalla se pondria al
   * dia y el navegador calcularia sobre el orden BUENO, que es justamente lo que
   * este caso necesita que no pase.
   *
   * Lo que queda probado con el corte es mas fuerte que antes: la reconciliacion
   * de la 9.2 no depende de que el aviso funcione. Es la red de abajo.
   */
  await cortarElFlujoDeCambios(page);
  await page.reload();
  await esperarSordo(page);

  await expect(titulos(page, POR_HACER)).toHaveText(comoSeVeAlCargar);
  expect(await correcciones(page)).toBe(0);

  // Un agente reordena la columna por debajo. La pantalla no se entera.
  await moverPorElNucleo(TITULO_VENCE_HOY, POR_HACER, 0);
  expect(await titulosEnLaBase(POR_HACER)).toEqual([
    TITULO_VENCE_HOY,
    TITULO_LARGO,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
  ]);
  // Sigue mostrando el de antes: es lo que hace que el calculo local diverja.
  await expect(titulos(page, POR_HACER)).toHaveText(comoSeVeAlCargar);

  await arrastrar(page, TITULO_LARGO, { columna: POR_HACER, indice: "final" });

  const ordenDelServidor = [
    TITULO_VENCE_HOY,
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_LARGO,
  ];
  const ordenQueCalculoElNavegador = [
    TITULO_CORTO,
    TITULO_VENCIDA_FUERA,
    TITULO_VENCE_HOY,
    TITULO_LARGO,
  ];

  // LA PANTALLA TERMINA CON EL DEL SERVIDOR.
  await expect(titulos(page, POR_HACER)).toHaveText(ordenDelServidor);
  await expect(titulos(page, POR_HACER)).not.toHaveText(ordenQueCalculoElNavegador);

  // Y la reconciliacion dice que tuvo que corregir: sin esto, un fallo del paso
  // 3 quedaria tapado por la revalidacion, que llega despues y trae lo mismo.
  await expect
    .poll(async () => correcciones(page), { message: "data-correcciones" })
    .toBe(1);

  // El orden de la pantalla es el de la base, no una coincidencia.
  await esperarColumnaEnLaBase(POR_HACER, ordenDelServidor);

  /**
   * Y LA CORRECCION SE VIO MOVERSE, que es la otra mitad del criterio: una
   * tarjeta que salta sin explicacion —justo despues de que la persona solto
   * otra— se lee como que el arrastre no funciono.
   *
   * Las tres que cambian de sitio entre el orden que calculo el navegador y el
   * del servidor son CORTO (0 a 1), VENCIDA (1 a 2) y HOY (2 a 0). LARGO se
   * queda en la ultima posicion en los dos, asi que NO se anima: animarla seria
   * mover algo que no se movio.
   */
  const animadas = new Set(await tarjetasAnimadas(page));

  expect([...animadas].sort()).toEqual(
    [TITULO_CORTO, TITULO_VENCE_HOY, TITULO_VENCIDA_FUERA].sort(),
  );
});

// --- 7. El gesto de verdad: con el raton ------------------------------------

/**
 * LA UNICA PRUEBA CON PUNTERO. Cubre lo que el teclado no puede cubrir: que el
 * sensor de puntero este montado, que la restriccion de distancia deje pasar el
 * arrastre, y —lo que de verdad podia romperse— que ese gesto NO abra el panel
 * de detalle, porque la tarjeta entera es un enlace.
 *
 * No afirma sobre una posicion exacta dentro de la columna destino: eso depende
 * de donde caiga el puntero al pixel, que es justo lo que las otras pruebas
 * evitan medir. Afirma lo que si es determinista: que la tarea CAMBIO de
 * columna, y que no se navego.
 */
test("arrastrar con el raton mueve la tarea y no abre el panel de detalle", async ({ page }) => {
  await expect(titulos(page, EN_PROGRESO)).toHaveText(["Montar Playwright"]);

  await arrastrarConRaton(page, TITULO_URGENTE, columna(page, EN_PROGRESO));

  await expect(tarjetasDe(page, EN_PROGRESO).locator(".tarjeta__titulo")).toContainText([
    TITULO_URGENTE,
  ]);
  await esperarColumnaEnLaBase(BACKLOG, [TITULO_MEDIA, TITULO_ALTA, TITULO_BAJA]);
  expect(await titulosEnLaBase(EN_PROGRESO)).toContain(TITULO_URGENTE);

  // El arrastre termina con un clic sobre un enlace y NO navega: ni panel, ni
  // parametro en la URL. Es lo que hace posible que la tarjeta siga siendo un
  // enlace y a la vez se pueda agarrar de cualquier parte.
  await expect(panel(page)).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");

  // Y un CLIC de verdad, sin mover, sigue abriendo el panel: la restriccion de
  // distancia distingue las dos cosas y no se comio el clic.
  await tarjeta(page, TITULO_MEDIA).click();
  await expect(panel(page)).toBeVisible();
});
