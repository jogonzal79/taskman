import type { Page } from "@playwright/test";

import { cortarLaEscucha, moverPorMcp } from "./base";
import {
  TITULO_ALTA,
  TITULO_BAJA,
  TITULO_CORTO,
  TITULO_MEDIA,
  TITULO_URGENTE,
} from "./semilla";
import {
  esperarEscuchando,
  esperarSordo,
  expect,
  retenerReconexiones,
  tarjetasDe,
  tarjetasMarcadas,
  test,
  titulosMarcados,
} from "./tablero";

/**
 * LA ESCUCHA SE CAE Y EL TABLERO NO SE MIENTE.
 *
 * EL FALLO QUE CIERRA. El servidor escucha la base con UNA conexion `LISTEN`
 * (`lib/cambios.ts`). Si PostgreSQL la corta, el flujo SSE sigue abierto y el
 * latido sigue llegando cada 30 s, asi que `EventSource` nunca da error: el
 * tablero queda SORDO mientras `data-cambios` dice "conectado". Medido antes del
 * arreglo, con este mismo corte: la escritura de control llegaba, la posterior
 * al corte no llegaba nunca, y los latidos seguian.
 *
 * LAS TRES COSAS QUE SE AFIRMAN, en el orden en que tienen que pasar:
 *
 *   1. SE ENTERA. Tras el corte, `data-cambios` deja de decir "conectado" y el
 *      navegador pide `/eventos` otra vez. Antes del arreglo esta prueba falla
 *      aca, con el atributo clavado en "conectado".
 *   2. SE PONE AL DIA. Lo que se escribio mientras estaba sordo aparece al
 *      reconectar SIN MARCA de cambio ajeno. La falta de marca es lo que dice
 *      que lo trajo el REFRESCO y no un aviso: la marca solo la pone un aviso, y
 *      ese aviso no existio para nadie (`NOTIFY` no guarda nada).
 *   3. VUELVE A OIR. Una escritura posterior llega como aviso, con su marca.
 *
 * QUE NO CUBRE, y no se da por probado:
 *
 *   - UNA CAIDA ENTERA DE POSTGRESQL, con reconexiones que fallan hasta que la
 *     base vuelve. Aca PostgreSQL sigue arriba y solo muere la conexion: la
 *     primera reconexion ya encuentra la base. Parar el contenedor desde una
 *     prueba se llevaria puesta la base que comparten el desarrollador y la
 *     propia suite, y tarda segundos en volver.
 *   - UNA CONEXION QUE MUERE SIN CERRARSE (sin FIN ni RST: un corte de red, un
 *     portatil que se durmio). `pg` no se entera de eso, asi que tampoco puede
 *     avisar, y el tablero seguiria sordo diciendo "conectado".
 */

/** Marca el documento: si la pantalla se pusiera al dia recargando, se perderia. */
async function marcarDocumento(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __mismoDocumento?: boolean }).__mismoDocumento = true;
  });
}

async function sigueElMismoDocumento(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __mismoDocumento?: boolean }).__mismoDocumento === true,
  );
}

function titulos(page: Page, nombreColumna: string) {
  return tarjetasDe(page, nombreColumna).locator(".tarjeta__titulo");
}

const BACKLOG = "Backlog";
const EN_PROGRESO = "En progreso";

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
  await esperarEscuchando(page);
});

test("si PostgreSQL corta la escucha, el tablero deja de decir conectado, reconecta y se pone al dia", async ({
  page,
}) => {
  await expect(titulos(page, EN_PROGRESO)).toHaveText(["Montar Playwright"]);
  await marcarDocumento(page);

  // Desde aca, toda reconexion espera a que la prueba la suelte. Ver
  // `retenerReconexiones`: es lo que deja escribir con el tablero sordo sin
  // carrera.
  const reconexiones = await retenerReconexiones(page);

  try {
    expect(await cortarLaEscucha(), "conexiones LISTEN cortadas").toBeGreaterThan(0);

    // 1. SE ENTERA: el atributo deja de mentir y el navegador intenta volver.
    await esperarSordo(page);
    await expect
      .poll(() => reconexiones.retenidas(), { message: "reintentos de /eventos" })
      .toBeGreaterThan(0);

    // Con el tablero sordo, un agente mueve una tarea. Nadie escucha ese NOTIFY.
    await moverPorMcp({ tarea: "Montar Playwright", aColumna: "BACKLOG", position: 0 });

    // La pantalla sigue en lo de antes: la unica forma de enterarse es la
    // reconexion, y esta retenida.
    await expect(titulos(page, EN_PROGRESO)).toHaveText(["Montar Playwright"]);
  } finally {
    reconexiones.soltar();
  }

  // 2. SE PONE AL DIA al reconectar.
  await esperarEscuchando(page);

  await expect(titulos(page, BACKLOG)).toHaveText([
    "Montar Playwright",
    TITULO_MEDIA,
    TITULO_URGENTE,
    TITULO_ALTA,
    TITULO_BAJA,
  ]);
  await expect(titulos(page, EN_PROGRESO)).toHaveText([]);

  // Sin marca: lo trajo el refresco, no un aviso. Y sin recargar el documento.
  await expect(tarjetasMarcadas(page)).toHaveCount(0);
  expect(await sigueElMismoDocumento(page)).toBe(true);

  // 3. VUELVE A OIR: lo que se escribe despues llega como aviso, con su marca.
  await moverPorMcp({ tarea: TITULO_CORTO, aColumna: "IN_PROGRESS", position: 0 });

  await expect(titulos(page, EN_PROGRESO)).toHaveText([TITULO_CORTO]);
  await expect(titulosMarcados(page)).toHaveText([TITULO_CORTO]);
  expect(await sigueElMismoDocumento(page)).toBe(true);
});
