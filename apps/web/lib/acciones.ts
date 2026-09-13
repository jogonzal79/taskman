"use server";

import { crearCorePort, isDomainError, recortarTitulo } from "@taskman/core";
import { revalidatePath } from "next/cache";

import { contextoDeUi } from "./actor";
import { registrarFallo } from "./log";

/**
 * Las Server Actions de la UI (9.1): "Las mutaciones desde el navegador usan
 * Server Actions, que invocan los mismos servicios. La UI no consume su propia
 * API publica."
 *
 * Es el lado de ESCRITURA de lo que `lib/tablero.ts` hace al leer, y por eso
 * vive al lado y con la misma forma: pide un `CorePort` y no toca Prisma (3.2),
 * asi que esta UI es un adaptador mas y no un camino privilegiado. Lo unico que
 * agrega respecto del borde REST es de donde sale el actor (ver `lib/actor.ts`)
 * y que la respuesta no es una `Response` sino un valor que un componente puede
 * pintar.
 *
 * POR QUE NO PASA POR /api/tasks. No es una preferencia de estilo: una peticion
 * HTTP desde el servidor a si mismo necesitaria una API key —la 7.2 exige scope
 * `write`— o sea que la UI tendria que guardar una credencial para hablar
 * consigo misma, y ademas pagaria un salto de red y una serializacion de ida y
 * vuelta para llegar al mismo `TaskService` que ya tiene importado. El precio de
 * NO pasar por ahi es que las validaciones del contrato de la 6.3.1 no se
 * aplican; las que importan son las del dominio, que si se aplican porque viven
 * en el nucleo (el titulo se normaliza en `TaskService.create`).
 *
 * ESTE MODULO NO IMPORTA NADA DE REACT y no renderiza: un archivo con
 * `"use server"` solo puede exportar funciones asincronas, asi que todo lo que no
 * es una accion —el contexto del actor, el log— vive en otro archivo. El
 * `contextoDeUi` esta separado justamente por eso, no por gusto.
 */

/**
 * Lo que una accion devuelve. Union discriminada y NO una excepcion, porque un
 * error lanzado dentro de una Server Action llega al navegador como el mensaje
 * generico de React ("An error occurred in the Server Components render") con el
 * detalle borrado a proposito en produccion: el usuario veria "algo fallo" y
 * nada mas, que es exactamente el fallo silencioso que hay que evitar.
 *
 * Devolviendolo, el mensaje del `DomainError` —que ya esta escrito para leerse,
 * con su limite y su hint— llega intacto al campo que lo produjo.
 */
export type ResultadoAccion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Para mostrar. Es el mensaje del dominio, o uno generico si no lo era. */
      readonly mensaje: string;
      /**
       * El codigo de la 5.3 cuando es un error de negocio, o `INTERNAL_ERROR`.
       * No se pinta: existe para que el componente pueda distinguir sin leer
       * texto, y para que una prueba afirme sobre el y no sobre una frase.
       */
      readonly codigo: string;
      /**
       * El mismo identificador que quedo en el log (11.1). Se muestra SOLO en el
       * fallo no controlado, que es el unico caso en el que el usuario no puede
       * hacer nada con el mensaje y lo unico util que puede copiar es esto.
       */
      readonly requestId?: string;
    };

const taskman = crearCorePort();

/**
 * Crea una tarea al FINAL de una columna: el QuickAdd de la 9.3.
 *
 * SIN `position`, y eso es lo que lo hace el caso barato. `TaskService.create`
 * interpreta la ausencia como "end", asi que ninguna tarea existente cambia de
 * lugar: la reescritura de la columna que corre dentro de la transaccion le
 * asigna a cada fila la posicion que ya tenia, y su `SET updated_at` esta
 * condicionado a `IS DISTINCT FROM`, o sea que ni siquiera ensucia las marcas de
 * tiempo. La densidad 0..n-1 sale sola porque la nueva va en el indice
 * `existentes.length`.
 *
 * SOLO EL TITULO. Prioridad, descripcion y fecha no se pasan y el servicio pone
 * sus valores por defecto (MEDIUM y null): se editan despues en el panel de
 * detalle, que es otro paso. Pedirlos aca convertiria el QuickAdd en un
 * formulario, que es justamente lo que no es.
 *
 * EL RECORTE PREVIO es una guarda de red, no la validacion: la que vale es
 * `normalizarTitulo` dentro del nucleo, que recorta con la clase de blancos
 * Unicode completa y lanza TITLE_REQUIRED. Esto corta el viaje a la base cuando
 * ya se sabe que no hay nada que crear, y no reimplementa nada: usa el MISMO
 * `recortarTitulo` del nucleo. El cliente hace la misma comprobacion antes de
 * enviar, asi que en la practica son tres, y la unica que decide es la de abajo.
 */
export async function crearTarea(entrada: {
  boardId: string;
  columnId: string;
  title: string;
}): Promise<ResultadoAccion> {
  if (recortarTitulo(entrada.title) === "") {
    // Ni se abre transaccion, asi que tampoco queda registro de auditoria: el
    // titulo se normaliza ANTES del `inTransaction` de `create`, de modo que
    // este camino y el del nucleo dejan la base exactamente igual.
    return {
      ok: false,
      mensaje: "Escribi un titulo para crear la tarea.",
      codigo: "TITLE_REQUIRED",
    };
  }

  const ctx = contextoDeUi();

  try {
    await taskman.createTask(
      { boardId: entrada.boardId, columnId: entrada.columnId, title: entrada.title },
      ctx,
    );
  } catch (error: unknown) {
    // Un error de negocio ya trae un mensaje escrito para una persona (5.3), y
    // es el que corresponde mostrar: "El campo title tiene 217 caracteres y el
    // maximo es 200" le dice al usuario exactamente que hacer.
    if (isDomainError(error)) {
      return { ok: false, mensaje: error.message, codigo: error.code };
    }

    // Y lo que no es de dominio es un fallo nuestro: la traza COMPLETA al log y
    // al usuario solo el codigo y el request_id, que son las dos mitades de la
    // 11.1. Es la misma politica de `respuestaDeFallo`, con la unica diferencia
    // de que el resultado no es una respuesta HTTP.
    registrarFallo(ctx.requestId, error);

    return {
      ok: false,
      mensaje: "No se pudo crear la tarea.",
      codigo: "INTERNAL_ERROR",
      requestId: ctx.requestId,
    };
  }

  /**
   * SIN ESTO LA TAREA SE CREA Y NO SE VE, que son dos cosas distintas.
   *
   * `export const dynamic = "force-dynamic"` en la pagina hace que el servidor
   * no cachee el render, pero el que guarda la copia vieja es el ROUTER DEL
   * CLIENTE: despues de una Server Action el navegador solo recibe un arbol
   * nuevo si la accion invalido la ruta. Sin `revalidatePath`, la fila esta en
   * la base y la pantalla sigue mostrando el tablero de antes hasta que alguien
   * recarga a mano. Medido: quitando esta linea falla la prueba de Playwright
   * del caso 1 y la tarea aparece igual en la base.
   *
   * La ruta es "/" porque la UI tiene una sola pagina y el tablero es esa. El
   * dia que haya una ruta por tablero, esto pasa a ser la ruta del tablero
   * afectado y no un comodin.
   */
  revalidatePath("/");

  return { ok: true };
}
