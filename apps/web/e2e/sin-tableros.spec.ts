import { columnasDelTableroEnLaBase } from "./base";
import { columnasVacias } from "./semilla";
import {
  avisoSinTablero,
  campoNuevoTablero,
  esperandoAlServidor,
  expect,
  itemsDeLaBarra,
  nombreDelTablero,
  tableroMarcado,
  test,
} from "./tablero";

/**
 * La base SIN NINGUN TABLERO: el estado de una instalacion recien migrada.
 *
 * Va aparte porque necesita su propia semilla, y porque es donde la creacion
 * desde la pantalla se juega entera: el primer tablero no tiene de donde salir
 * mas que de la barra. Hasta este paso la pagina, sin tableros, no dibujaba la
 * barra —"estaria vacia al lado de un hueco"— y mandaba a crear uno por la API o
 * por MCP. Con la creacion en la barra eso habria dejado la 18 del funcional sin
 * cumplir justo para el primero.
 */
test.use({ semilla: "ninguno" });

const PRIMERO = "Mi primer tablero";

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

test("sin ningun tablero, la barra crea el primero y queda seleccionado", async ({ page }) => {
  const cuatro = columnasVacias();

  // El aviso dice que no hay, y a donde ir. La barra esta, vacia, con el campo.
  await expect(avisoSinTablero(page)).toContainText("No hay ningun tablero todavia");
  await expect(itemsDeLaBarra(page)).toHaveCount(0);
  await expect(campoNuevoTablero(page)).toBeVisible();

  await campoNuevoTablero(page).fill(PRIMERO);
  await esperandoAlServidor(page, () => campoNuevoTablero(page).press("Enter"));

  await expect(nombreDelTablero(page)).toHaveText(PRIMERO);
  await expect(tableroMarcado(page)).toHaveText(PRIMERO);
  await expect(avisoSinTablero(page)).toHaveCount(0);
  await expect(page.locator(".columna__nombre")).toHaveText(cuatro.map((columna) => columna.name));

  expect(await columnasDelTableroEnLaBase(PRIMERO)).toEqual(
    cuatro.map((columna, position) => ({ key: columna.key, name: columna.name, position })),
  );
});
