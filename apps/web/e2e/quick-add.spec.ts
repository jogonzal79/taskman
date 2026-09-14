import { columnaEnLaBase } from "./base";
import { columnaDe } from "./semilla";
import {
  campoNuevaTarea,
  columna,
  esperandoAlServidor,
  esperarColumnaEnLaBase,
  expect,
  tarjetasDe,
  test,
} from "./tablero";

/**
 * QuickAdd (9.3): crear una tarea escribiendo el titulo al pie de una columna.
 *
 * Cubre los casos 1, 4 y 6 del paso —crear y que aparezca, el titulo vacio, y
 * Escape— mas el del titulo demasiado largo, que es el unico que prueba que el
 * error LLEGA A LA PANTALLA. La position al final SI se afirma por SQL, en la
 * ultima prueba (CT-02, abajo), con la lectura directa de la base de
 * `e2e/base.ts`. El `actor_type` USER de la tarea creada NO se afirma en ninguna
 * prueba de extremo a extremo; el de un tablero creado desde la barra si (CT-01,
 * `tableros.spec.ts`).
 *
 * LO QUE HACE QUE ESTAS PRUEBAS MIDAN "SE VE" Y NO SOLO "SE CREO": ninguna
 * recarga. Se marca `window` antes de teclear y se comprueba que la marca
 * sobrevive, o sea que no hubo carga de documento: si la actualizacion de la
 * pantalla dependiera de un `location.reload()` encubierto, la marca se perderia.
 *
 * LA EXCEPCION ES LA ULTIMA, que es el CT-02 completo y RECARGA a proposito.
 * Las dos cosas no se contradicen: las de arriba comprueban que la pantalla se
 * actualiza SOLA, y aquella que lo que se creo esta DE VERDAD en la base. Una
 * pantalla que se actualiza sola sin escribir pasaria todas las de arriba.
 */

/** Lo que se escribe en el campo en el caso normal. */
const TITULO_NUEVO = "Escribir la prueba del QuickAdd";
const TITULO_SIGUIENTE = "Y otra mas sin volver a pulsar";

/** 201 caracteres: uno mas que `LIMITE_TITULO`. */
const TITULO_LARGUISIMO = "a".repeat(201);

/**
 * Marca el documento actual. Si la pantalla se actualizara recargando, la marca
 * se iria con el documento viejo.
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

// --- 1. Enter crea, aparece al final, y el campo queda listo ----------------

test("Enter crea la tarea al final de la columna y deja el campo listo para la siguiente", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);
  const campo = campoNuevaTarea(page, porHacer.name);

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(sembradas);

  await marcar(page);
  await campo.fill(TITULO_NUEVO);
  await campo.press("Enter");

  // AL FINAL, no en cualquier sitio: la lista completa y en orden es la
  // asercion, con la nueva en la ultima posicion.
  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText([
    ...sembradas,
    TITULO_NUEVO,
  ]);

  // El recuento de la cabecera sale del agregado de la base, no de contar lo
  // pintado: que cambie prueba que el servidor volvio a renderizar de verdad.
  await expect(columna(page, porHacer.name).locator(".columna__recuento")).toHaveText(
    String(sembradas.length + 1),
  );

  // SIN RECARGAR: el documento es el mismo que antes de teclear.
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // LISTO PARA LA SIGUIENTE: vacio, enfocado y sin error a la vista.
  await expect(campo).toHaveValue("");
  await expect(campo).toBeFocused();
  await expect(columna(page, porHacer.name).locator(".nueva__error")).toHaveCount(0);

  // Y de verdad listo: la segunda se crea sin volver a pulsar en el campo.
  await campo.fill(TITULO_SIGUIENTE);
  await campo.press("Enter");

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText([
    ...sembradas,
    TITULO_NUEVO,
    TITULO_SIGUIENTE,
  ]);
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // La columna de al lado no se movio: `boardId` y `columnId` llegaron bien.
  const backlog = columnaDe(sembrado.activo, "BACKLOG");
  await expect(tarjetasDe(page, backlog.name).locator(".tarjeta__titulo")).toHaveText(
    backlog.tareas.map((tarea) => tarea.title),
  );
});

// --- 4. Vacio y solo espacios: no crea nada ---------------------------------

test("un titulo vacio o de solo espacios no crea nada", async ({ page, sembrado }) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);
  const tarjetas = tarjetasDe(page, porHacer.name);
  const campo = campoNuevaTarea(page, porHacer.name);

  await marcar(page);

  // Enter sobre el campo vacio.
  await campo.press("Enter");
  await expect(tarjetas).toHaveCount(sembradas.length);

  /**
   * Y sobre espacios de varias clases: espacio normal, tabulacion y ESPACIO DURO
   * (U+00A0), que es el que se cuela al pegar texto de una pagina. El nucleo los
   * cuenta como vacio con su clase de blancos Unicode completa, y el CHECK
   * `title ~ '\S'` de la base NO —la clase POSIX es solo ASCII—, asi que este es
   * el caso que distingue una guarda de verdad de una que se apoya en la base.
   */
  await campo.fill("   \t  ");
  await campo.press("Enter");

  await expect(tarjetas).toHaveCount(sembradas.length);
  await expect(tarjetas.locator(".tarjeta__titulo")).toHaveText(sembradas);
  await expect(columna(page, porHacer.name).locator(".columna__recuento")).toHaveText(
    String(sembradas.length),
  );
  expect(await sigueElMismoDocumento(page)).toBe(true);
});

// --- 6. Escape cancela ------------------------------------------------------

test("Escape descarta lo escrito sin crear nada", async ({ page, sembrado }) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);
  const campo = campoNuevaTarea(page, porHacer.name);

  await marcar(page);
  await campo.fill("Esto no tiene que crearse");
  await campo.press("Escape");

  // El campo se vacia y la columna queda como estaba.
  await expect(campo).toHaveValue("");
  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(sembradas);

  // Cancelar es deshacer lo escrito, no salir del campo: el foco se queda.
  await expect(campo).toBeFocused();
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // Un Enter despues del Escape tampoco crea: lo que habia se descarto de
  // verdad, no quedo en un estado interno del componente.
  await campo.press("Enter");
  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(sembradas);
});

// --- 5. El titulo demasiado largo: el usuario ve el error -------------------

test("un titulo de mas de 200 caracteres muestra el error y conserva lo escrito", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);
  const campo = campoNuevaTarea(page, porHacer.name);
  const aviso = columna(page, porHacer.name).locator(".nueva__error");

  await marcar(page);
  await campo.fill(TITULO_LARGUISIMO);
  await campo.press("Enter");

  // El mensaje es el del dominio, con el numero y el limite: es lo que le dice a
  // la persona cuanto tiene que recortar. Que llegue entero es el punto de que la
  // accion DEVUELVA el error en vez de lanzarlo.
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("201");
  await expect(aviso).toContainText("200");

  // No es una pagina rota ni un fallo silencioso: el tablero sigue ahi y no se
  // creo nada.
  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(sembradas);
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // Y LO ESCRITO SE CONSERVA, que es la mitad util del error: vaciar el campo
  // borraria justo lo que el mensaje esta pidiendo recortar.
  await expect(campo).toHaveValue(TITULO_LARGUISIMO);

  // El aviso se va al corregir, y entonces si crea.
  await campo.fill("Titulo corto al fin");
  await expect(aviso).toHaveCount(0);
  await campo.press("Enter");

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText([
    ...sembradas,
    "Titulo corto al fin",
  ]);
});

// --- 2. CT-02 completo: crear, RECARGAR, y la position en la base -----------

/**
 * CT-02 de la 10.2: "Crear tarea con QuickAdd, recargar, verificar que persiste
 * en la posicion correcta".
 *
 * LAS DOS MITADES QUE LE FALTABAN a las pruebas de arriba, y ninguna es
 * decorativa:
 *
 *   - LA RECARGA. Sin ella, todo lo que se afirma sale del arbol que la
 *     revalidacion mando al navegador; un servidor que revalidara con la tarea
 *     en memoria y no la escribiera pasaria igual. Con documento nuevo, lo que
 *     se ve vuelve a salir de la base por el camino de lectura del Server
 *     Component.
 *   - LA POSITION POR SQL. "En la posicion correcta" no se ve: una tarjeta
 *     ultima en pantalla es compatible con `position` 0, 1, 2, 7 en la base, y
 *     el hueco no se paga hasta que algo reordene. `esperarColumnaEnLaBase`
 *     comprueba ademas que la columna sigue DENSA con la nueva dentro (ADR-004).
 *
 * EL ORDEN IMPORTA: primero se espera la respuesta del servidor, DESPUES se
 * recarga. Es lo que costo una intermitente en el CT-03 —`page.reload()` con la
 * Server Action en vuelo aborta la escritura— y el hito sin carrera es el mismo,
 * la respuesta POST. Ver `esperandoAlServidor`.
 */
test("CT-02: la tarea creada persiste al recargar, al final de la columna y sin huecos", async ({
  page,
  sembrado,
}) => {
  const porHacer = columnaDe(sembrado.activo, "TODO");
  const sembradas = porHacer.tareas.map((tarea) => tarea.title);
  const campo = campoNuevaTarea(page, porHacer.name);

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(sembradas);

  await campo.fill(TITULO_NUEVO);
  // Se espera a que el servidor conteste ANTES de recargar: con la accion en
  // vuelo, la recarga aborta la peticion y la tarea no llega a escribirse.
  await esperandoAlServidor(page, () => campo.press("Enter"));

  const esperadas = [...sembradas, TITULO_NUEVO];

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(esperadas);

  // RECARGA: documento nuevo, y lo que se ve sale otra vez de la base.
  await page.reload();

  await expect(tarjetasDe(page, porHacer.name).locator(".tarjeta__titulo")).toHaveText(esperadas);
  await expect(columna(page, porHacer.name).locator(".columna__recuento")).toHaveText(
    String(esperadas.length),
  );

  // Y EN LA BASE: los mismos titulos en orden y las positions densas 0..n-1.
  await esperarColumnaEnLaBase(porHacer.name, esperadas);

  /**
   * Y la position de la nueva, dicha como NUMERO y por su nombre.
   *
   * Honestamente: no atrapa nada que las dos aserciones de arriba dejen pasar.
   * El listado ordena por `position` y la columna ya se comprobo densa, asi que
   * la position de cada tarea ES su indice en pantalla; esto se deduce. Esta por
   * lo que dice el MENSAJE cuando algo falla —"la nueva quedo en la 0 y se
   * esperaba la 4" localiza el problema mucho mas rapido que una lista de
   * enteros— y porque escribe "al final de la columna" como el numero que es, que
   * es literalmente lo que pide el CT-02.
   */
  const nueva = (await columnaEnLaBase(porHacer.name)).find(
    (fila) => fila.title === TITULO_NUEVO,
  );

  expect(nueva?.position).toBe(sembradas.length);

  // La columna de al lado no se movio.
  const backlog = columnaDe(sembrado.activo, "BACKLOG");

  await esperarColumnaEnLaBase(
    backlog.name,
    backlog.tareas.map((tarea) => tarea.title),
  );
});
