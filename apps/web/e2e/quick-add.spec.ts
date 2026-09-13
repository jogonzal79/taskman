import { columnaDe } from "./semilla";
import { campoNuevaTarea, columna, expect, tarjetasDe, test } from "./tablero";

/**
 * QuickAdd (9.3): crear una tarea escribiendo el titulo al pie de una columna.
 *
 * Cubre los casos 1, 4 y 6 del paso —crear y que aparezca, el titulo vacio, y
 * Escape— mas el del titulo demasiado largo, que es el unico que prueba que el
 * error LLEGA A LA PANTALLA. Los dos que se comprueban por SQL —la position al
 * final y el `actor_type` USER de la auditoria— no estan aca: son sobre la base y
 * no sobre el render, y afirmarlos desde el navegador obligaria a exponer un
 * camino de lectura que la UI no tiene.
 *
 * LO QUE HACE QUE ESTAS PRUEBAS MIDAN "SE VE" Y NO SOLO "SE CREO": ninguna
 * recarga. Se marca `window` antes de teclear y se comprueba que la marca
 * sobrevive, o sea que no hubo carga de documento: si la actualizacion de la
 * pantalla dependiera de un `location.reload()` encubierto, la marca se perderia.
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
