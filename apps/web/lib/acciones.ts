"use server";

import {
  crearCorePort,
  isDomainError,
  recortarTitulo,
  type ActorContext,
  type Priority,
  type UpdateTaskInput,
} from "@taskman/core";
import { revalidatePath } from "next/cache";

import { contextoDeUi } from "./actor";
import { registrarFallo } from "./log";
import { aFechaUtc } from "./tareas";

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
 * La politica de errores y la revalidacion, en UN solo lugar para las tres
 * acciones.
 *
 * Estaba escrita dentro de `crearTarea` cuando era la unica. Con tres, copiarla
 * dejaria tres versiones de la misma decision libres de separarse, y la que se
 * separaria primero es la revalidacion: es la linea facil de olvidar —el dato se
 * escribe igual y la pantalla se queda vieja, sin ningun error— y la que la
 * contraprueba del QuickAdd demostro que hace falta.
 *
 * REVALIDA SIEMPRE DESPUES DEL EXITO, incluso cuando el nucleo no escribio nada
 * (un patch sin cambio efectivo es exito sin escritura, 5.2). Revalidar de mas
 * cuesta un render; no revalidar cuesta una pantalla que miente. Y el borde no
 * puede saber si hubo escritura sin volver a implementar "cambio efectivo", que
 * es justamente la definicion que vive en el nucleo y no debe tener copias.
 */
async function ejecutar(operacion: (ctx: ActorContext) => Promise<void>): Promise<ResultadoAccion> {
  const ctx = contextoDeUi();

  try {
    await operacion(ctx);
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
      mensaje: "No se pudo completar la operacion.",
      codigo: "INTERNAL_ERROR",
      requestId: ctx.requestId,
    };
  }

  /**
   * SIN ESTO EL DATO SE ESCRIBE Y NO SE VE, que son dos cosas distintas.
   *
   * `export const dynamic = "force-dynamic"` en la pagina hace que el servidor
   * no cachee el render, pero el que guarda la copia vieja es el ROUTER DEL
   * CLIENTE: despues de una Server Action el navegador solo recibe un arbol
   * nuevo si la accion invalido la ruta. Sin `revalidatePath`, la fila esta en
   * la base y la pantalla sigue mostrando el tablero de antes hasta que alguien
   * recarga a mano. Medido dos veces: quitando esta linea fallan las pruebas de
   * Playwright que crean y las que editan, y el dato aparece igual en la base.
   *
   * La ruta es "/" porque la UI tiene una sola pagina y el tablero es esa —el
   * panel de detalle es un parametro de consulta de esa misma ruta, asi que
   * entra en la misma invalidacion y se repinta con los valores nuevos—. El dia
   * que haya una ruta por tablero, esto pasa a ser la ruta del tablero afectado
   * y no un comodin.
   */
  revalidatePath("/");

  return { ok: true };
}

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

  return ejecutar(async (ctx) => {
    await taskman.createTask(
      { boardId: entrada.boardId, columnId: entrada.columnId, title: entrada.title },
      ctx,
    );
  });
}

/**
 * LA ENTRADA DEL PATCH desde la UI: los cuatro campos editables de la 5.2, todos
 * OPCIONALES, y `description` y `dueDate` ademas nullables.
 *
 * Es la misma forma que el cuerpo de PATCH /api/tasks/{id}, y eso es deliberado:
 * la distincion que decide todo —ausente es "no lo toques", null es "borralo"—
 * tiene que verse en el TIPO y no en un comentario. `dueDate` viaja como cadena
 * `AAAA-MM-DD` y no como `Date` por la razon de abajo (ver `editarTarea`).
 *
 * POSITION Y COLUMNID NO ESTAN, y no es un olvido: la 5.2 dice que "no son
 * modificables aqui; requieren move". `UpdateTaskInput` tampoco los tiene, asi
 * que el nucleo no los rechazaria, los IGNORARIA —exactamente el problema que el
 * borde REST resuelve con un 400 y un hint—. Aca el borde es codigo nuestro y no
 * un cuerpo JSON de un tercero, asi que la defensa es el tipo: un campo que no
 * esta en esta interfaz no compila en el llamador.
 */
export interface CamposDeTarea {
  title?: string;
  description?: string | null;
  priority?: Priority;
  /** `AAAA-MM-DD`, o `null` para quitar el vencimiento. */
  dueDate?: string | null;
}

/**
 * Edita una tarea: el guardado por campo del TaskDetailPanel (9.3).
 *
 * EL SPREAD CONDICIONAL ES EL PASO ENTERO. Mantiene separados "no mandaste el
 * campo" y "lo mandaste en null", que es la unica forma de poder pedir que se
 * BORRE una descripcion o un vencimiento. `TaskService.update` decide con
 * `patch.description === undefined`, asi que una clave PRESENTE en undefined se
 * comporta igual que una ausente y las dos intenciones llegarian identicas.
 *
 * Lo defiende el TYPECHECK y NO la suite, igual que en los dos handlers REST que
 * hacen esto mismo: cambiarlo por `description: entrada.description` deja toda la
 * suite en verde y falla con TS2375 por `exactOptionalPropertyTypes`. Lo que la
 * suite SI atrapa son los colapsos que COMPILAN, y son dos, cada uno con su
 * prueba en la base:
 *
 *   - Convertir el campo vacio a `""` en vez de a `null` (lo hace el cliente,
 *     ver `task-editor.tsx`): compila, y guarda una cadena vacia donde tenia que
 *     quedar NULL. Se ve por SQL y no en pantalla, porque una descripcion vacia
 *     y una NULL se pintan igual.
 *   - `?? null` en lugar del spread: compila si se escribe
 *     `description: entrada.description ?? null`, y entonces NO tocar la
 *     descripcion pasa a BORRARLA.
 *
 * `dueDate` LLEGA COMO CADENA y se ancla aca con `aFechaUtc`, la misma conversion
 * del borde REST. Es lo que impide el corrimiento de un dia: la columna es DATE,
 * el proceso corre en UTC-4, y un `new Date("2026-09-20")` construido en el
 * CLIENTE y serializado daria el dia anterior. Construyendo la fecha en el
 * servidor y siempre con la `Z` explicita, el dia que se guarda es el dia que se
 * eligio. Por eso la interfaz de arriba declara `string` y no `Date`: la unica
 * forma de no correrla es no dejar que una `Date` cruce.
 *
 * NO COMPRUEBA "SIN CAMBIO EFECTIVO", y es a proposito: esa definicion vive en
 * `TaskService.update` (5.2), que compara campo por campo y devuelve exito sin
 * escribir ni auditar. Duplicarla aca seria una segunda definicion libre de
 * separarse. El cliente igual no manda un campo que no toco, pero eso es ahorrar
 * un viaje, no una regla.
 */
export async function editarTarea(
  taskId: string,
  entrada: CamposDeTarea,
): Promise<ResultadoAccion> {
  const patch: UpdateTaskInput = {
    ...(entrada.title === undefined ? {} : { title: entrada.title }),
    ...(entrada.description === undefined ? {} : { description: entrada.description }),
    ...(entrada.priority === undefined ? {} : { priority: entrada.priority }),
    ...(entrada.dueDate === undefined
      ? {}
      : { dueDate: entrada.dueDate === null ? null : aFechaUtc(entrada.dueDate) }),
  };

  return ejecutar(async (ctx) => {
    await taskman.updateTask(taskId, patch, ctx);
  });
}

/**
 * Borra una tarea. El servicio reindexa su columna en la misma transaccion y
 * registra DELETE con la entidad completa en `before_data` (5.2 y 7.4): nada de
 * eso se pide desde aca, y un borrado que dejara un hueco seria un bug del
 * nucleo y no de este borde.
 *
 * NO LLEVA `confirm`, a diferencia de la herramienta MCP. Ver el comentario de
 * `BotonBorrar` en `task-editor.tsx`: la confirmacion de esta superficie es un
 * segundo clic en la pantalla, no un parametro. Ponerlo aca ademas seria una
 * mentira de tipos —un booleano que el llamador siempre pasa en true no protege
 * de nada— y la 8.3.2 habla explicitamente de la capa MCP.
 *
 * TASK_NOT_FOUND sube como `DomainError` y llega al panel como mensaje: es el
 * caso de borrar una tarea que otro actor ya borro —un agente por MCP, otra
 * pestana— y el usuario tiene que enterarse de que su clic no hizo lo que creia.
 */
export async function borrarTarea(taskId: string): Promise<ResultadoAccion> {
  return ejecutar(async (ctx) => {
    await taskman.deleteTask(taskId, ctx);
  });
}
