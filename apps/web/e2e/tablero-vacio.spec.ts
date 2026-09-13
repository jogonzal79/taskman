import { columna, expect, test } from "./tablero";

/**
 * Un tablero SIN NINGUNA TAREA (caso 5).
 *
 * Es el estado en el que queda un tablero recien creado —cuatro columnas de la
 * 4.3 y nada dentro— o sea el primero que ve cualquiera, y es donde una pagina se
 * rompe: recuentos calculados sobre listas vacias, un `items[0]` que no existe,
 * un contenedor que colapsa. Va en su propio archivo porque necesita su propia
 * semilla: la pagina muestra el PRIMER tablero del listado, asi que para ver uno
 * vacio tiene que ser el primero, y entonces el sembrado no se ve.
 */
test.use({ semilla: "vacio" });

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

test("un tablero sin tareas muestra las cuatro columnas vacias y no rompe", async ({
  page,
  sembrado,
}) => {
  const { activo } = sembrado;

  await expect(page.locator(".cabecera__nombre")).toHaveText(activo.name);

  // Singular y plural del recuento: con cero, "0 tareas".
  await expect(page.locator(".cabecera__recuento")).toHaveText("0 tareas");

  // Las cuatro columnas siguen ahi. Un tablero vacio no es un tablero sin
  // columnas, y confundir las dos cosas es la forma tipica de que la pantalla
  // vacia se lea como un error.
  await expect(page.locator(".columna__nombre")).toHaveText(
    activo.columnas.map((definicion) => definicion.name),
  );

  await expect(page.locator(".tarjeta")).toHaveCount(0);

  for (const definicion of activo.columnas) {
    const seccion = columna(page, definicion.name);

    await expect(seccion.locator(".columna__recuento")).toHaveText("0");
    // Estado normal declarado, no un hueco: una columna que no dice nada se lee
    // como una que no cargo.
    await expect(seccion.locator(".columna__vacia")).toHaveText("Sin tareas");
    // Y el aviso de pagina cortada no aparece donde no hubo corte.
    await expect(seccion.locator(".columna__resto")).toHaveCount(0);
  }

  // La barra lateral con un solo tablero sigue marcandolo.
  await expect(page.locator('.barra__item[aria-current="true"]')).toHaveText(activo.name);
});
