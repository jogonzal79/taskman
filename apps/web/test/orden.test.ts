import { describe, expect, it } from "vitest";

import {
  columnaDe,
  mismoOrden,
  moverEnOrdenVisible,
  posicionParaElNucleo,
  proyectarOrdenDelServidor,
  type OrdenVisible,
} from "../lib/orden";

/**
 * La aritmetica del arrastre (`lib/orden.ts`), probada SIN navegador y SIN base.
 *
 * Es la unica suite de `apps/web` que no abre una conexion, y no es una rareza:
 * lo que mide son funciones puras. La traduccion del indice VISIBLE al
 * `position` REAL es lo mas facil de equivocar de todo el paso —se equivoca
 * callada, dejando la tarea un lugar corrida— y desde Playwright se veria el
 * resultado y no la cuenta, asi que un fallo ahi diria "la tarjeta quedo mal"
 * sin decir por que.
 *
 * EL ORACULO DE CADA CASO es `computeMoveOrder` del nucleo, reimplementado aca
 * abajo en tres lineas (`comoElNucleo`). No se importa del nucleo a proposito:
 * lo que hay que comprobar es que estas cuentas producen el mismo orden que la
 * transaccion va a escribir, y para eso hace falta una SEGUNDA descripcion de
 * esa semantica. Importando la primera, la prueba pasaria igual si las dos
 * estuvieran mal.
 */

/**
 * Lo que hace el nucleo con un `position`: saca la tarea de donde este e
 * inserta en el indice pedido sobre la columna destino YA SIN ella.
 */
function comoElNucleo(
  columnaCompleta: readonly string[],
  taskId: string,
  indice: number | "end",
): string[] {
  const resto = columnaCompleta.filter((id) => id !== taskId);
  const posicion = indice === "end" ? resto.length : Math.min(indice, resto.length);

  resto.splice(posicion, 0, taskId);

  return resto;
}

/** Las positions 0..n-1 de una columna completa. */
function positions(columna: readonly string[]): Map<string, number> {
  return new Map(columna.map((id, indice) => [id, indice] as const));
}

describe("moverEnOrdenVisible", () => {
  const orden: OrdenVisible = { A: ["a1", "a2", "a3"], B: ["b1"], C: [] };

  it("mueve dentro de la misma columna con la semantica de saca-e-inserta", () => {
    expect(moverEnOrdenVisible(orden, "a1", "A", 2)["A"]).toEqual(["a2", "a3", "a1"]);
    expect(moverEnOrdenVisible(orden, "a3", "A", 0)["A"]).toEqual(["a3", "a1", "a2"]);
  });

  it("mueve entre columnas y deja densa la de origen", () => {
    const nuevo = moverEnOrdenVisible(orden, "a2", "B", 0);

    expect(nuevo["A"]).toEqual(["a1", "a3"]);
    expect(nuevo["B"]).toEqual(["a2", "b1"]);
  });

  it("acepta una columna vacia como destino", () => {
    expect(moverEnOrdenVisible(orden, "a1", "C", 0)["C"]).toEqual(["a1"]);
  });

  it("ajusta al tamano un indice que se pasa, igual que el nucleo", () => {
    expect(moverEnOrdenVisible(orden, "b1", "A", 99)["A"]).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("no toca las columnas que no intervienen", () => {
    const nuevo = moverEnOrdenVisible(orden, "a1", "B", 0);

    expect(nuevo["C"]).toEqual([]);
  });
});

describe("columnaDe", () => {
  const orden: OrdenVisible = { A: ["a1"], B: ["b1", "b2"] };

  it("encuentra la columna de una tarea", () => {
    expect(columnaDe(orden, "b2")).toBe("B");
  });

  it("devuelve undefined si la tarea no esta en ninguna", () => {
    expect(columnaDe(orden, "z9")).toBeUndefined();
  });
});

/**
 * SIN FILTRO: el indice visible ES la position, asi que la traduccion tiene que
 * ser la identidad. Es el caso que se da siempre en uso normal, y el que
 * comprueba que el mecanismo del filtro no cobra peaje cuando no hay filtro.
 */
describe("posicionParaElNucleo, sin filtro", () => {
  const columna = ["t0", "t1", "t2", "t3"];
  const posiciones = positions(columna);

  it("reproduce el orden que se ve, para CADA destino de una columna de cuatro", () => {
    for (const movida of columna) {
      for (let destino = 0; destino < columna.length; destino += 1) {
        const visible = columna.filter((id) => id !== movida);
        visible.splice(destino, 0, movida);

        const position = posicionParaElNucleo({
          destinoFinal: visible,
          taskId: movida,
          mismaColumna: true,
          posiciones,
        });

        // Lo que la pantalla mostro y lo que la transaccion va a escribir tienen
        // que ser la misma lista. Es la afirmacion entera del archivo.
        expect(comoElNucleo(columna, movida, position)).toEqual(visible);
      }
    }
  });

  it("entre columnas, el indice pedido es el indice visible", () => {
    const destinoCompleto = ["d0", "d1"];
    const visible = ["d0", "x", "d1"];

    const position = posicionParaElNucleo({
      destinoFinal: visible,
      taskId: "x",
      mismaColumna: false,
      posiciones: positions(destinoCompleto),
    });

    expect(position).toBe(1);
    expect(comoElNucleo([...destinoCompleto], "x", position)).toEqual(["d0", "x", "d1"]);
  });

  it("al final de una columna con contenido pide el indice de mas alla del ultimo", () => {
    const destinoCompleto = ["d0", "d1"];

    const position = posicionParaElNucleo({
      destinoFinal: ["d0", "d1", "x"],
      taskId: "x",
      mismaColumna: false,
      posiciones: positions(destinoCompleto),
    });

    expect(position).toBe(2);
  });

  it('sobre una columna que se ve vacia pide "end", que es lo unico que no inventa un sitio', () => {
    expect(
      posicionParaElNucleo({
        destinoFinal: ["x"],
        taskId: "x",
        mismaColumna: false,
        posiciones: new Map(),
      }),
    ).toBe("end");
  });
});

/**
 * CON FILTRO es donde el indice visible deja de servir. La columna real tiene
 * seis tareas y la pantalla muestra dos: soltar entre las dos NO es el indice 1.
 */
describe("posicionParaElNucleo, con filtro", () => {
  // Seis tareas reales, positions 0..5. El filtro deja ver la 1 y la 4.
  const columnaCompleta = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const posiciones = positions(columnaCompleta);

  it("soltar ENTRE las dos visibles deja la tarea entre ellas en la columna real", () => {
    const position = posicionParaElNucleo({
      destinoFinal: ["c1", "x", "c4"],
      taskId: "x",
      mismaColumna: false,
      posiciones,
    });

    // El indice visible habria sido 1, y habria puesto la tarea antes de `c1`.
    expect(position).toBe(4);

    const real = comoElNucleo([...columnaCompleta], "x", position);

    expect(real).toEqual(["c0", "c1", "c2", "c3", "x", "c4", "c5"]);
    // Y lo que se ve de esa columna real es exactamente lo que se solto.
    expect(real.filter((id) => ["c1", "x", "c4"].includes(id))).toEqual(["c1", "x", "c4"]);
  });

  it("soltar ANTES de la primera visible la deja antes de ella, no al principio de la columna", () => {
    const position = posicionParaElNucleo({
      destinoFinal: ["x", "c1", "c4"],
      taskId: "x",
      mismaColumna: false,
      posiciones,
    });

    expect(position).toBe(1);
    expect(comoElNucleo([...columnaCompleta], "x", position)).toEqual([
      "c0",
      "x",
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("soltar DESPUES de la ultima visible la deja justo despues de ella, no al final", () => {
    const position = posicionParaElNucleo({
      destinoFinal: ["c1", "c4", "x"],
      taskId: "x",
      mismaColumna: false,
      posiciones,
    });

    expect(position).toBe(5);
    expect(comoElNucleo([...columnaCompleta], "x", position)).toEqual([
      "c0",
      "c1",
      "c2",
      "c3",
      "c4",
      "x",
      "c5",
    ]);
  });

  it("dentro de la MISMA columna filtrada, el ajuste por la que se saca acierta", () => {
    // Visibles: c1 y c4. Se mueve c1 detras de c4.
    const position = posicionParaElNucleo({
      destinoFinal: ["c4", "c1"],
      taskId: "c1",
      mismaColumna: true,
      posiciones,
    });

    // 4 es la position de `c4`, menos uno porque `c1` sale de mas arriba.
    expect(position).toBe(4);

    const real = comoElNucleo([...columnaCompleta], "c1", position);

    expect(real).toEqual(["c0", "c2", "c3", "c4", "c1", "c5"]);
    expect(real.filter((id) => ["c1", "c4"].includes(id))).toEqual(["c4", "c1"]);
  });

  it("y hacia atras, donde NO hay que ajustar", () => {
    // Se mueve c4 delante de c1.
    const position = posicionParaElNucleo({
      destinoFinal: ["c4", "c1"],
      taskId: "c4",
      mismaColumna: true,
      posiciones,
    });

    expect(position).toBe(1);

    const real = comoElNucleo([...columnaCompleta], "c4", position);

    expect(real).toEqual(["c0", "c4", "c1", "c2", "c3", "c5"]);
    expect(real.filter((id) => ["c1", "c4"].includes(id))).toEqual(["c4", "c1"]);
  });
});

describe("proyectarOrdenDelServidor", () => {
  it("se queda con el orden del servidor, no con el del cliente", () => {
    expect(proyectarOrdenDelServidor(["b", "a", "c"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("descarta lo que el cliente no puede dibujar", () => {
    // `oculta` la esconde el filtro: el cliente no tiene ni su titulo.
    expect(proyectarOrdenDelServidor(["a", "oculta", "b"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("deja fuera lo que el cliente mostraba y el servidor ya no tiene", () => {
    // Otro actor la borro mientras la pantalla estaba abierta.
    expect(proyectarOrdenDelServidor(["a", "c"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});

describe("mismoOrden", () => {
  it("distingue un orden distinto de uno igual", () => {
    expect(mismoOrden(["a", "b"], ["a", "b"])).toBe(true);
    expect(mismoOrden(["a", "b"], ["b", "a"])).toBe(false);
    expect(mismoOrden(["a"], ["a", "b"])).toBe(false);
  });
});
