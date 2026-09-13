import { test as base, expect, type Locator, type Page } from "@playwright/test";

import {
  sembrar,
  tableroActivo,
  type NombreDeSemilla,
  type Semilla,
  type TableroSembrado,
} from "./semilla";

/**
 * El `test` de estas pruebas: el de Playwright con la siembra de la 10.3
 * enganchada, mas los localizadores del tablero.
 *
 * POR QUE UNA FIXTURE Y NO UN `beforeAll`. La siembra corre antes de CADA prueba
 * y vacia la base entera. Con un `beforeAll` por archivo seria mas rapido, pero
 * la segunda prueba de un archivo pasaria a depender de que la primera no haya
 * tocado nada, y esa dependencia no se ve al leerla: se descubre el dia que una
 * prueba nueva escribe algo. Es la misma decision que el `beforeEach` con
 * TRUNCATE de las suites de vitest, y es lo que hace que dos corridas seguidas
 * sin limpiar nada den lo mismo.
 *
 * LA SEMILLA ES UNA OPCION, no un parametro: un archivo entero elige la suya con
 * `test.use({ semilla: "vacio" })`. Asi la eleccion se lee arriba del archivo y no
 * repetida en cada prueba.
 */

export interface DatosSembrados {
  /** La semilla completa, tal como se escribio. */
  semilla: Semilla;
  /** El tablero que la pagina muestra: el primero del listado. */
  activo: TableroSembrado;
  /**
   * El instante contra el que se resolvieron los desplazamientos de fecha. Las
   * aserciones tienen que usar ESTE y no un `new Date()` propio.
   */
  hoy: Date;
}

export const test = base.extend<{
  semilla: NombreDeSemilla;
  sembrado: DatosSembrados;
}>({
  semilla: ["principal", { option: true }],

  sembrado: async ({ semilla }, use) => {
    const hoy = new Date();
    const datos = await sembrar(semilla, hoy);

    await use({ semilla: datos, activo: tableroActivo(datos), hoy });
  },
});

export { expect };

// --- Localizadores -----------------------------------------------------------

/**
 * Una columna POR SU NOMBRE ACCESIBLE, no por su posicion ni por su clase. El
 * `<section>` de `ColumnCard` lleva `aria-labelledby` apuntando a su `<h2>`, asi
 * que esto es la region que un lector de pantalla anunciaria con ese nombre: si
 * ese enlace se rompiera, la prueba deja de encontrar la columna, que es
 * exactamente lo que hay que enterarse.
 */
export function columna(page: Page, nombre: string): Locator {
  return page.getByRole("region", { name: nombre, exact: true });
}

/** Las tarjetas de una columna, en el orden del DOM (que es el de `position`). */
export function tarjetasDe(page: Page, nombreColumna: string): Locator {
  return columna(page, nombreColumna).locator(".tarjeta");
}

/** Una tarjeta concreta, por el titulo con el que se sembro. */
export function tarjeta(page: Page, titulo: string): Locator {
  return page.locator(".tarjeta").filter({ has: page.locator(`h3[title="${titulo}"]`) });
}

/** El `<h3>` de una tarjeta: es el elemento al que se le aplica el recorte. */
export function tituloDe(page: Page, titulo: string): Locator {
  return tarjeta(page, titulo).locator(".tarjeta__titulo");
}

// --- Lectura del render ------------------------------------------------------

/**
 * Una propiedad CALCULADA del elemento, no la declarada en la hoja.
 *
 * Es la diferencia entre esta suite y leer el HTML a mano: una clase presente en
 * el atributo no prueba que la regla se aplique —puede estar pisada, puede que la
 * hoja ni siquiera haya cargado— y `getComputedStyle` sale del motor despues de
 * resolver la cascada.
 */
export async function estiloCalculado(
  locator: Locator,
  propiedad: string,
): Promise<string> {
  return locator.evaluate(
    (elemento, nombre) => getComputedStyle(elemento).getPropertyValue(nombre),
    propiedad,
  );
}

export interface MedidaDeTitulo {
  /** Alto de la CAJA, ya recortada. */
  alto: number;
  /** Alto del CONTENIDO, sin recortar. Mayor que `alto` cuando algo se corto. */
  altoSinRecortar: number;
  /** El alto de UNA linea, leido del elemento y no supuesto. */
  lineaPx: number;
}

/**
 * Mide el titulo de una tarjeta. Es lo que no se podia comprobar leyendo el HTML:
 * el recorte a dos lineas es una regla de CSS, y cuantas lineas ocupa un texto no
 * esta escrito en ningun lado hasta que un motor de maquetado lo resuelve.
 *
 * `lineaPx` se LEE del elemento en vez de fijarse en la prueba. Un 19.6 escrito
 * aca convertiria a esta prueba en guardiana del `line-height`, que no es lo que
 * mide: cambiar la tipografia romperia el recorte sin que nadie lo haya tocado.
 * Leyendolo, lo que se afirma es la relacion —dos lineas y no una, ni tres— que
 * es la regla de verdad.
 */
export async function medirTitulo(locator: Locator): Promise<MedidaDeTitulo> {
  return locator.evaluate((elemento) => {
    const estilo = getComputedStyle(elemento);
    const lineaPx = Number.parseFloat(estilo.lineHeight);

    return {
      alto: elemento.getBoundingClientRect().height,
      altoSinRecortar: elemento.scrollHeight,
      lineaPx,
    };
  });
}
