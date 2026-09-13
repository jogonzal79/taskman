/**
 * Los tipos minimos de JSON que necesita el generador.
 *
 * Estan escritos aca y no importados de ninguna parte porque el tsconfig de
 * este paquete lleva `"types": []`: no hay `@types/node` ni ningun global de
 * entorno, y esa ausencia es lo que mantiene a `src/` como contrato puro. El
 * generador vive dentro de `src/` (3.3 pone la generacion de OpenAPI en este
 * paquete) y por eso NO puede tocar el sistema de archivos: devuelve texto, y
 * quien lo escribe es `build.mjs`.
 */
export type ValorJson = string | number | boolean | null | readonly ValorJson[] | ObjetoJson;

export interface ObjetoJson {
  [clave: string]: ValorJson;
}

/** Estrecha un valor a objeto sin `as`, para recorrer un esquema convertido. */
export function esObjeto(valor: ValorJson | undefined): valor is ObjetoJson {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/**
 * Serializa de forma ESTABLE: el mismo documento da los mismos bytes.
 *
 * NO reordena claves, y eso es deliberado. El orden de un objeto de JS es el de
 * insercion para claves de texto, asi que ya es determinista: sale del orden en
 * que este generador escribe cada objeto y del que `z.toJSONSchema` recorre cada
 * esquema —que es el orden de declaracion de los campos, mas util de leer en un
 * diff que el alfabetico—. Ordenar alfabeticamente cambiaria eso por un orden
 * estable de otra forma, no por uno mas estable.
 *
 * La excepcion la pone JS y no este codigo: las claves que parecen enteros se
 * serializan primero y en orden numerico, asi que los codigos de estado de
 * `responses` salen ascendentes se declaren como se declaren.
 *
 * Lo que si fija esta funcion es el formato: dos espacios de indentacion, salto
 * final, y LF —lo escribe `build.mjs` sin traducir— para que el archivo
 * versionado no cambie de bytes por el entorno que lo genero.
 */
export function serializarEstable(documento: ObjetoJson): string {
  return `${JSON.stringify(documento, null, 2)}\n`;
}
