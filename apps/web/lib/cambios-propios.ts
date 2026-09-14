"use client";

/**
 * LOS CAMBIOS QUE HIZO ESTA PESTAÑA, por su `request_id`.
 *
 * Existe para una sola pregunta: cuando llega un aviso por `/eventos`, ¿lo
 * produje YO? Si es propio, `ColumnList` no refresca, porque la Server Action
 * ya revalido la ruta. NO decide la marca de cambio ajeno: esa sale del actor
 * —solo se marcan AGENT y API—, asi que un cambio propio no se marca nunca, se
 * reconozca aca o no.
 *
 * POR QUE NO ALCANZA CON `actor_type` para decidir el refresco: un cambio hecho
 * por el usuario en OTRA pestaña tambien es USER, y esa pantalla SI tiene que
 * refrescarse. El `request_id` es lo que separa lo propio de lo ajeno entre
 * pestañas del mismo usuario.
 *
 * HOY NO SE CUMPLE A TIEMPO, y esta medido. El `requestId` se anota recien
 * cuando la accion responde, y el aviso propio llega antes: en 10 de 10
 * creaciones con QuickAdd, con el flujo vivo y sin carga, ninguno se reconocio y
 * cada uno pidio un refresco de mas. No se ve —la marca no depende de esto—, pero
 * cada escritura renderiza la pagina dos veces. Esta en "Deuda conocida" de
 * CLAUDE.md, con el arreglo elegido.
 *
 * VIVE EN EL MODULO Y NO EN UN COMPONENTE porque los productores estan repartidos
 * —cada componente que llama a una Server Action anota su `requestId` por su
 * lado— y el consumidor es uno solo. Un contexto de React seria el mismo Set con
 * un proveedor alrededor; en el navegador un modulo de cliente ya es una
 * instancia por documento, que es exactamente el alcance que hace falta.
 *
 * NO SIRVE PARA NADA MAS. No es una cache ni un registro de actividad: es una
 * ventana corta de identificadores, y por eso se poda.
 */

/**
 * Cuantos se recuerdan. El unico consumidor es el aviso que llega por el flujo
 * inmediatamente despues de la escritura, asi que con unas pocas decenas sobra;
 * el tope existe para que una sesion larga no acumule identificadores para
 * siempre.
 */
const TOPE = 50;

const propios: string[] = [];

/** Anota una escritura hecha desde esta pestaña. */
export function recordarCambioPropio(requestId: string): void {
  propios.push(requestId);

  if (propios.length > TOPE) {
    propios.splice(0, propios.length - TOPE);
  }
}

/**
 * Si el aviso lo produjo esta pestaña.
 *
 * Un aviso SIN `request_id` cuenta como ajeno: la unica forma de que falte es
 * que la escritura no lo llevara, y en ese caso no hay con que atribuirla. Es la
 * eleccion segura de las dos —como mucho, un refresco de mas— frente a la
 * contraria, que seria no enterarse de un cambio ajeno.
 */
export function esCambioPropio(requestId: string | null): boolean {
  return requestId !== null && propios.includes(requestId);
}
