"use client";

import { useId, useState, useTransition } from "react";

import { crearTarea } from "../lib/acciones";
import { recordarCambioPropio } from "../lib/cambios-propios";

/**
 * QuickAddInput (9.3): "Creacion de tarea escribiendo el titulo al final de una
 * columna."
 *
 * FUE EL PRIMER COMPONENTE DE CLIENTE DEL PROYECTO, y esta escrito para seguir
 * siendo el mas chico posible: un campo, tres piezas de estado y nada mas. No
 * conoce el tablero, no conoce las tarjetas y no lee datos: los ids llegan como
 * propiedades. Cuando se escribio, el limite cliente/servidor caia exactamente
 * aca; desde el arrastre cae mas arriba, en `ColumnList`, que es de cliente y
 * arrastra con el a `ColumnCard` y a este componente.
 *
 * ESTE COMPONENTE NO TIENE ESTADO QUE RECONCILIAR. No toca la lista de tarjetas:
 * la accion invalida la ruta (`revalidatePath`) y Next devuelve el arbol nuevo
 * junto con la respuesta de la accion. Lo unico que guarda es lo que el servidor
 * no puede saber —que hay tecleado, si hay algo en vuelo y cual fue el ultimo
 * error—. La reconciliacion optimista de la 9.2 vive en el arrastre
 * (`ColumnList`), y por que no hay TanStack Query esta en la cabecera de ese
 * archivo y en los desvios declarados de CLAUDE.md.
 *
 * UN `<form>` Y NO un `onKeyDown` que compare "Enter". El submit nativo ya
 * resuelve lo que ese `if` tendria que resolver a mano: el Enter del teclado
 * numerico, el de un metodo de entrada que todavia esta componiendo —donde Enter
 * confirma la conversion y NO envia— y el autocompletado del navegador. Escape,
 * en cambio, no tiene evento propio y va por `onKeyDown`.
 */

export function QuickAdd({
  boardId,
  columnId,
  columnName,
}: {
  boardId: string;
  columnId: string;
  /** Solo para el nombre accesible: "Nueva tarea en Backlog". */
  columnName: string;
}) {
  const [titulo, setTitulo] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * `useTransition` y no un booleano propio: `isPending` sigue en true hasta que
   * TERMINA tambien la actualizacion del arbol que devuelve la accion, no solo la
   * escritura. Con un booleano manual habria una ventana en la que la tarea ya
   * esta creada y la columna todavia no la muestra, y en esa ventana el campo se
   * veria listo. Es la diferencia entre "se creo" y "se creo y se ve", que es lo
   * mismo que mide la prueba del caso 1.
   */
  const [enVuelo, iniciar] = useTransition();

  // `useId` y no una cadena fija: hay un QuickAdd por columna, y cuatro campos
  // apuntando al mismo id de error romperian la relacion para el lector de
  // pantalla justo en el momento en que importa.
  const idError = useId();

  function enviar(): void {
    // La misma comprobacion que hace la accion y que hace el nucleo. Aca ahorra
    // el viaje: un Enter sobre un campo vacio es lo que mas se pulsa de todo
    // esto, y no tiene sentido despertar una transaccion para nada.
    if (titulo.trim() === "") {
      return;
    }

    /**
     * DOS ENTER SEGUIDOS NO CREAN DOS TAREAS. Esta guarda es la unica proteccion
     * que tiene este camino: la 6.5 le da al borde REST una `Idempotency-Key`
     * para exactamente este problema, y una Server Action no tiene cabeceras
     * donde llevarla. Mientras hay algo en vuelo el submit se descarta.
     */
    if (enVuelo) {
      return;
    }

    iniciar(async () => {
      const resultado = await crearTarea({ boardId, columnId, title: titulo });

      if (resultado.ok) {
        // Esta creacion es NUESTRA: se anota para que su aviso por `/eventos` no
        // pida un refresco de mas. Hoy llega tarde —el aviso entra antes que esta
        // respuesta, 10 de 10 medido— y el refresco sale igual; ver la deuda en
        // CLAUDE.md. La tarjeta no se marca por otro motivo: la marca la decide
        // el actor, y lo que escribe la UI es USER.
        recordarCambioPropio(resultado.requestId);

        // El campo queda LISTO PARA LA SIGUIENTE: se vacia y nunca se deshabilita,
        // asi que el foco no se pierde y se puede seguir escribiendo sin volver a
        // pulsar. Deshabilitarlo mientras crea seria lo natural y esta descartado
        // por eso: el navegador saca el foco de un campo deshabilitado y no lo
        // devuelve.
        setTitulo("");
        setError(null);

        return;
      }

      /**
       * EL ERROR SE MUESTRA Y EL TEXTO SE CONSERVA. Lo segundo importa mas de lo
       * que parece: el caso real es un titulo de mas de 200 caracteres, y vaciar
       * el campo al fallar le borraria a la persona lo que acaba de escribir
       * justo cuando el mensaje le esta pidiendo que lo recorte.
       */
      setError(
        resultado.requestId === undefined
          ? resultado.mensaje
          : `${resultado.mensaje} (${resultado.requestId})`,
      );
    });
  }

  return (
    <form
      className="nueva"
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar();
      }}
    >
      <input
        className="nueva__campo"
        type="text"
        value={titulo}
        placeholder={enVuelo ? "Creando..." : "+ Nueva tarea"}
        aria-label={`Nueva tarea en ${columnName}`}
        // La relacion campo-error solo existe cuando hay error: un
        // aria-describedby que apunta a un elemento ausente no describe nada.
        {...(error === null ? {} : { "aria-invalid": true, "aria-describedby": idError })}
        // Sin autocompletado ni correccion: es un titulo, no un dato de
        // formulario, y el navegador no tiene nada util que proponer.
        autoComplete="off"
        onChange={(evento) => {
          setTitulo(evento.target.value);

          // El error se va en cuanto se toca el campo: dejarlo puesto mientras se
          // corrige el titulo lo convierte en una etiqueta permanente que ya no
          // describe lo que hay escrito.
          if (error !== null) {
            setError(null);
          }
        }}
        onKeyDown={(evento) => {
          if (evento.key !== "Escape") {
            return;
          }

          /**
           * ESCAPE CANCELA: descarta lo tecleado y el error, sin crear nada y sin
           * tocar la base. No quita el foco a proposito —"cancelar" es deshacer
           * lo escrito, no salir del campo— asi que despues de un Escape se puede
           * empezar a escribir de nuevo directamente.
           *
           * `stopPropagation` porque Escape es la tecla que cierra cosas: el
           * panel de detalle de la 9.3 lo escucha en `document` para cerrarse, y
           * un Escape tecleado en este campo tiene que limpiar el campo y NO
           * cerrar el panel de al lado.
           */
          evento.stopPropagation();
          setTitulo("");
          setError(null);
        }}
      />

      {/*
        `role="alert"` para que un lector de pantalla lo anuncie sin que nadie
        mueva el foco: el campo sigue siendo el sitio donde hay que corregir.
      */}
      {error !== null && (
        <p className="nueva__error" id={idError} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
