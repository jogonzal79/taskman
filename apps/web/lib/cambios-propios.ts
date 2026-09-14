"use client";

/**
 * LOS CAMBIOS QUE HIZO ESTA PESTAÑA, por su `request_id`.
 *
 * Existe para una sola pregunta, y es la que decide si el realce de la 9.1 sirve
 * o es ruido: cuando llega un aviso por `/eventos`, ¿lo produje YO?
 *
 * POR QUE NO ALCANZA CON `actor_type`. La 7.4 distingue USER, AGENT y API, y
 * marcar solo AGENT y API ya evita marcarse a uno mismo. Pero deja fuera la otra
 * mitad: un cambio hecho por el usuario en OTRA pestaña tambien es USER, y esa
 * pantalla SI tiene que refrescarse. Con el `request_id` las dos cosas se
 * distinguen sin adivinar: propio es propio, y todo lo demas —otra pestaña, un
 * agente, la API— es ajeno.
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
 * eleccion segura de las dos —refrescar de mas y, como mucho, marcar algo que
 * era propio— frente a la contraria, que seria no enterarse de un cambio ajeno.
 */
export function esCambioPropio(requestId: string | null): boolean {
  return requestId !== null && propios.includes(requestId);
}
