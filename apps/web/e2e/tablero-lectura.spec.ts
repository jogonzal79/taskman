import {
  columnaDe,
  fechaRelativa,
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
  columna,
  estiloCalculado,
  expect,
  medirTitulo,
  tarjeta,
  tarjetasDe,
  test,
  tituloDe,
} from "./tablero";

/**
 * El tablero en modo lectura (9.1 y 9.3) visto por un navegador de verdad.
 *
 * QUE APORTA ESTE NIVEL sobre la suite de vitest de al lado. Las pruebas de
 * `apps/web/test` importan Route Handlers y los invocan a mano: nunca renderizan
 * una pagina, y lo que se sabia de esta UI hasta ahora salia de leer el HTML del
 * servidor a ojo. Un navegador agrega las dos cosas que ese HTML no dice:
 *
 *   - Que la HOJA DE ESTILO se aplique. Una clase en el atributo no prueba nada:
 *     puede estar pisada por otra regla, o la hoja puede no haber cargado. Por eso
 *     donde la 9.3 pide que algo "se vea distinto" se afirma sobre
 *     `getComputedStyle` y no sobre el nombre de la clase.
 *   - Que el LAYOUT resuelva. El recorte del titulo a dos lineas y el corte por
 *     ancho de pantalla son geometria: no existen hasta que un motor de maquetado
 *     los calcula.
 *
 * La cobertura respecto de los diez escenarios CT de la 10.2 esta al pie del
 * archivo.
 */

/** `AAAA-MM-DD`, que es lo que el componente pone en el atributo `datetime`. */
function iso(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

test.beforeEach(async ({ page, sembrado }) => {
  // `sembrado` se pide aunque no se use aca: es lo que fuerza a la fixture a
  // vaciar y sembrar ANTES de que la pagina cargue.
  void sembrado;
  await page.goto("/");
});

// --- 1. Las cuatro columnas, y las tareas de cada una, en su orden ----------

test("las cuatro columnas de la 4.3 salen en orden, con sus tareas en el suyo", async ({
  page,
  sembrado,
}) => {
  const { activo } = sembrado;

  await expect(page.locator(".cabecera__nombre")).toHaveText(activo.name);

  // El orden de las columnas es el de `position`, no el alfabetico ni el de
  // creacion: "Backlog, Por hacer, En progreso, Completado" no esta ordenado de
  // ninguna otra forma, asi que la lista entera es la asercion.
  await expect(page.locator(".columna__nombre")).toHaveText(
    activo.columnas.map((definicion) => definicion.name),
  );

  for (const definicion of activo.columnas) {
    const titulos = definicion.tareas.map((tarea) => tarea.title);

    // `toHaveText` sobre un localizador de varios elementos compara la lista
    // COMPLETA y en orden: una tarea de mas, de menos o corrida hace fallar.
    await expect(
      tarjetasDe(page, definicion.name).locator(".tarjeta__titulo"),
      `las tarjetas de ${definicion.name}`,
    ).toHaveText(titulos);

    // El recuento de la cabecera de columna es el agregado de la base, no
    // `tasks.length`. Con estos volumenes tienen que coincidir, y que coincidan
    // es lo que dice que no se corto la pagina.
    await expect(columna(page, definicion.name).locator(".columna__recuento")).toHaveText(
      String(titulos.length),
    );
  }

  const total = activo.columnas.reduce((suma, definicion) => suma + definicion.tareas.length, 0);
  await expect(page.locator(".cabecera__recuento")).toHaveText(`${total} tareas`);
});

// --- 2. URGENT y HIGH se ven distintas de MEDIUM ----------------------------

test("URGENT y HIGH llevan etiqueta y borde propios; MEDIUM no lleva ninguno", async ({
  page,
}) => {
  const urgente = tarjeta(page, TITULO_URGENTE);
  const alta = tarjeta(page, TITULO_ALTA);
  const media = tarjeta(page, TITULO_MEDIA);
  const baja = tarjeta(page, TITULO_BAJA);

  await expect(urgente.locator(".prioridad")).toHaveText("Urgente");
  await expect(alta.locator(".prioridad")).toHaveText("Alta");

  // La AUSENCIA es la decision de la 9.3 tal como se implemento: MEDIUM y LOW no
  // llevan chip. `toHaveCount(0)` y no `toBeHidden()`: no tiene que estar oculto,
  // tiene que no existir.
  await expect(media.locator(".prioridad")).toHaveCount(0);
  await expect(baja.locator(".prioridad")).toHaveCount(0);

  // Y "se ven distintas" medido en el motor, no en el atributo class: el borde
  // izquierdo es la unica diferencia que se nota sin leer la tarjeta, asi que los
  // tres colores tienen que ser tres.
  const bordes = await Promise.all(
    [urgente, alta, media].map((tarjeta) => estiloCalculado(tarjeta, "border-left-color")),
  );

  expect(new Set(bordes).size, `border-left-color de URGENT/HIGH/MEDIUM: ${bordes.join(", ")}`).toBe(
    3,
  );

  // El chip de URGENT es la unica pieza con relleno solido de la pagina, y el de
  // HIGH no: si los dos terminaran con el mismo fondo, dejarian de distinguirse
  // entre si aunque las dos siguieran distinguiendose de MEDIUM.
  const fondoUrgente = await estiloCalculado(urgente.locator(".prioridad"), "background-color");
  const fondoAlta = await estiloCalculado(alta.locator(".prioridad"), "background-color");
  expect(fondoUrgente).not.toBe(fondoAlta);
});

// --- 3. La marca de vencida, dentro y fuera de DONE -------------------------

test("una vencida fuera de DONE lleva marca; la misma dentro de DONE no", async ({
  page,
  sembrado,
}) => {
  const { hoy } = sembrado;

  const fuera = tarjeta(page, TITULO_VENCIDA_FUERA).locator("time");
  const enDone = tarjeta(page, TITULO_VENCIDA_EN_DONE).locator("time");

  // Las dos vencieron: el atributo `datetime` lo dice sin depender del formato
  // legible, que cambia con el idioma y con si el ano es el corriente.
  await expect(fuera).toHaveAttribute("datetime", iso(fechaRelativa(hoy, -3)));
  await expect(enDone).toHaveAttribute("datetime", iso(fechaRelativa(hoy, -10)));

  // La marca es LA PALABRA y no solo el color (asi sobrevive a una captura en
  // gris), y este es el invariante del paso anterior: la que ya esta terminada no
  // la lleva aunque su fecha haya pasado.
  await expect(fuera).toContainText("Vencida");
  await expect(enDone).not.toContainText("Vencida");

  // Y ademas se ven distintas de verdad, no solo por la clase.
  expect(await estiloCalculado(fuera, "color")).not.toBe(await estiloCalculado(enDone, "color"));

  // El borde de la regla: vencer HOY todavia no es estar vencida (`esVencida`
  // compara por dia UTC, con `<` y no `<=`). Sin esto, cambiar esa comparacion
  // pasaria sin que ninguna prueba de pantalla se enterara.
  const hoyMismo = tarjeta(page, TITULO_VENCE_HOY).locator("time");
  await expect(hoyMismo).toHaveAttribute("datetime", iso(fechaRelativa(hoy, 0)));
  await expect(hoyMismo).not.toContainText("Vencida");
});

// --- 4. La barra lateral marca el tablero activo ----------------------------

test("la barra lateral lista los tableros y marca exactamente el que se muestra", async ({
  page,
  sembrado,
}) => {
  const { semilla, activo } = sembrado;

  await expect(page.locator(".barra__item")).toHaveText(
    semilla.tableros.map((tablero) => tablero.name),
  );

  const marcado = page.locator('.barra__item[aria-current="true"]');

  // EXACTAMENTE uno: con dos tableros sembrados, "marca el activo" y "marca
  // todos" darian lo mismo si solo se comprobara que el activo esta marcado.
  await expect(marcado).toHaveCount(1);
  await expect(marcado).toHaveText(activo.name);

  // Y el que marca es el que se esta viendo, no otro de la lista.
  await expect(page.locator(".cabecera__nombre")).toHaveText(activo.name);

  // La marca se ve sin depender del color, que en esta pagina esta reservado a
  // prioridad y vencimiento: es peso y fondo.
  const otro = page.locator(".barra__item:not([aria-current])").first();
  expect(await estiloCalculado(marcado, "font-weight")).not.toBe(
    await estiloCalculado(otro, "font-weight"),
  );
});

// --- 6. El recorte del titulo a dos lineas ----------------------------------

test("el titulo largo ocupa dos lineas y se corta ahi; el corto ocupa una", async ({ page }) => {
  const largo = await medirTitulo(tituloDe(page, TITULO_LARGO));
  const corto = await medirTitulo(tituloDe(page, TITULO_CORTO));

  // Si `line-height` saliera "normal", `parseFloat` daria NaN y todas las
  // comparaciones de abajo pasarian a ser falsas de un modo que se lee como "el
  // recorte no funciona". Se descarta primero.
  expect(Number.isFinite(largo.lineaPx), `line-height leido: ${largo.lineaPx}`).toBe(true);
  expect(largo.lineaPx).toBe(corto.lineaPx);

  // Tolerancia de 1 px y no igualdad exacta: el alto de linea calculado sale de
  // la metrica de la fuente del sistema y no cae siempre en un entero.
  const linea = largo.lineaPx;

  expect(
    Math.abs(corto.alto - linea),
    `el titulo corto mide ${corto.alto} px y una linea son ${linea} px`,
  ).toBeLessThan(1);

  expect(
    Math.abs(largo.alto - 2 * linea),
    `el titulo largo mide ${largo.alto} px y dos lineas son ${2 * linea} px`,
  ).toBeLessThan(1);

  // Que mida dos lineas no alcanza: un titulo que entrara justo en dos mediria
  // lo mismo sin que hubiera recorte ninguno. Lo que prueba el recorte es que el
  // CONTENIDO sea mas alto que la caja.
  expect(
    largo.altoSinRecortar,
    `el contenido sin recortar mide ${largo.altoSinRecortar} px y la caja ${largo.alto} px`,
  ).toBeGreaterThan(largo.alto + linea / 2);

  // Y el corto no se corta: su contenido entra entero.
  expect(corto.altoSinRecortar).toBeLessThan(corto.alto + linea / 2);

  // El titulo completo sigue estando, recortado o no: es lo que el `title` del
  // elemento promete y lo que hace que el recorte sea visual y no perdida de dato.
  await expect(tituloDe(page, TITULO_LARGO)).toHaveAttribute("title", TITULO_LARGO);
  await expect(tituloDe(page, TITULO_LARGO)).toHaveText(TITULO_LARGO);
});

// --- 7. Por debajo de 1024 px, el aviso y NADA de tablero -------------------

test("por debajo de 1024 px sale el aviso, no una version degradada", async ({ page }) => {
  const aviso = page.locator(".aviso-angosto");
  const backlog = columna(page, "Backlog");

  // 1024 es el limite declarado en `globals.css`: a 1024 se ve el tablero.
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(backlog).toBeVisible();
  await expect(aviso).toBeHidden();

  // Un pixel menos y cambia. NO se recarga entre medio a proposito: el corte es
  // una media query, no JavaScript midiendo el ancho, asi que tiene que ocurrir
  // sin que el servidor vuelva a renderizar nada.
  await page.setViewportSize({ width: 1023, height: 800 });
  await expect(aviso).toBeVisible();

  // "El mensaje y NO una version degradada": el tablero entero desaparece, no se
  // reacomoda. Se comprueban las dos puntas —el marco y una columna— porque
  // ocultar el contenedor y dejar una columna suelta seria justamente eso.
  await expect(page.locator(".marco")).toBeHidden();
  await expect(backlog).toBeHidden();

  // `:visible` y no `toHaveCount(0)` a secas: el corte es una media query sobre
  // HTML ya servido, asi que las once tarjetas SIGUEN en el DOM y contarlas daria
  // once. Lo que tiene que ser cero es lo que se ve. (Contarlas fue el primer
  // intento y fallo por eso.)
  await expect(page.locator(".tarjeta:visible")).toHaveCount(0);
});

/**
 * COBERTURA RESPECTO DE LA 10.2, para los SEIS archivos de este directorio y no
 * solo para este.
 *
 * Vive al pie de esta suite porque es la primera que existio y porque CLAUDE.md
 * apunta aca; se actualiza en el mismo commit que mueve la cobertura, que es la
 * unica forma de que no mienta. (Estuvo tres commits mintiendo: decia que
 * faltaban el QuickAdd, el panel y los filtros cuando ya estaban.)
 *
 *   CT-01  Crear tablero y ver las cuatro columnas por defecto.
 *          PARCIAL. "Ver las cuatro columnas" esta cubierto arriba y en
 *          `tablero-vacio.spec.ts`, sobre un tablero creado por la siembra con el
 *          mismo `createBoard` que usaria la UI. Falta CREARLO desde la pantalla,
 *          que es lo que pide la 18 del funcional ("se puede crear un tablero y
 *          sus columnas desde la UI") y que la 12.1 traza justamente a este CT.
 *          Aparte —y no es lo mismo, aunque se arreglen juntos— falta el
 *          "selector de tablero" que la 9.3 le asigna a BoardHeader: hoy la
 *          pagina muestra siempre el primero por nombre (`cargarVista`), asi que
 *          con mas de un tablero el segundo es inalcanzable. Crear sin poder
 *          cambiar dejaria el tablero nuevo invisible si no ordena primero.
 *          Lo que NO falta: crear, borrar o reordenar COLUMNAS desde la UI. El
 *          capitulo 9 no se lo asigna a ningun componente, la 18 traza sus
 *          "columnas" a este CT —o sea a que aparezcan las cuatro de la 4.3— y el
 *          "Columnas: CRUD y orden" de la 3 ya lo satisface la API.
 *   CT-02  QuickAdd, recargar, verificar la posicion.
 *          CUBIERTO, en `quick-add.spec.ts`. La ultima prueba del archivo recarga
 *          y afirma la position por SQL; las otras siguen comprobando lo
 *          contrario a proposito —que la pantalla se actualiza SIN recargar— y
 *          las dos cosas no se pisan: una pantalla que se refrescara sola sin
 *          escribir pasaria aquellas y no esta.
 *   CT-03  Arrastrar entre columnas y recargar.
 *          CUBIERTO, en `arrastre.spec.ts`, con la recarga y con el orden denso
 *          comprobado por SQL en las dos columnas.
 *   CT-04  Editar titulo, prioridad y fecha en el panel de detalle.
 *          CUBIERTO, en `task-detail.spec.ts`: titulo, descripcion, prioridad y
 *          FECHA, los cuatro con su reflejo en la tarjeta. La fecha se comprueba
 *          en los dos extremos —el dia en la base con `to_char` y el texto de la
 *          tarjeta— porque el corrimiento de un dia se puede introducir al
 *          escribir o al leer, y una sola punta no distingue los dos casos.
 *   CT-05  Eliminar una tarea intermedia y verificar que el orden queda denso.
 *          CUBIERTO, en `task-detail.spec.ts`, con una prueba propia que borra la
 *          tercera de cuatro y comprueba la densidad 0..n-1 por SQL. Hacia falta
 *          separarla: en pantalla las tres que quedan se ven igual con positions
 *          0,1,2 que con 0,1,3, asi que la prueba de borrado que ya existia no
 *          podia medir esto.
 *   CT-06  Crear por API con la UI abierta y revalidar.
 *          CUBIERTO, en `cambios-ajenos.spec.ts`, con una peticion HTTP real y su
 *          API key (asi el actor es API y no uno inventado). Comprueba ademas que
 *          NO hubo recarga de documento.
 *   CT-07  Mover por MCP y ver el reflejo en la UI.
 *          CUBIERTO, en `cambios-ajenos.spec.ts`, por el registro unico de
 *          herramientas de la 8.1 —el mismo codigo que ejecuta `apps/mcp-stdio`—
 *          con resolucion por nombre y actor AGENT. Lo unico que no recorre es el
 *          transporte stdio.
 *   CT-08  Clave sin scope delete contra la UI de borrado.    Falta: la UI no usa
 *          la API ni claves (9.1), asi que este escenario no tiene superficie aca;
 *          el scope si esta cubierto en la suite de contrato de `apps/web/test`.
 *   CT-09  Filtrar por prioridad y por vencidas.              CUBIERTO, en
 *          `filtros.spec.ts`, incluido que el conjunto filtrado por vencidas y el
 *          que la UI marca como vencido sean el mismo.
 *   CT-10  Operacion destructiva y su registro en audit_log.  Falta: el borrado
 *          desde la UI ya existe (CT-05), lo que no se comprueba desde aca es el
 *          `before_data` completo. Es una lectura de `audit_log`, que `e2e/base.ts`
 *          ya podria hacer.
 */
