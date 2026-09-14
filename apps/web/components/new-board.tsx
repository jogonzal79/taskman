"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { crearTablero } from "../lib/acciones";
import { recordarCambioPropio } from "../lib/cambios-propios";
import { enlaceAOtroTablero, type Filtros } from "../lib/filtros";

/**
 * "Nuevo tablero", al pie de la lista de la barra lateral (18 del funcional y
 * CT-01).
 *
 * UN CAMPO Y NO UN BOTON DESTACADO. Un tablero se crea una vez cada mucho, y un
 * boton lleno en la barra competiria todos los dias con la lista, que es lo que
 * se usa. En reposo se lee como un item mas en tinta apagada ("+ Nuevo tablero")
 * y se declara campo al tocarlo. Es la forma del QuickAdd a proposito: la misma
 * accion —escribir un nombre y Enter— para crear lo que sea, y el mismo trato del
 * error. Un formulario de varios campos no tiene sentido cuando lo unico que se
 * pide es el nombre: la descripcion del tablero no se muestra en ningun sitio de
 * esta UI, y las columnas son las de la 4.3.
 *
 * AL CREAR, EL TABLERO NUEVO QUEDA SELECCIONADO. Sin eso se crearia, apareceria en
 * la barra en el lugar que le toque por nombre, y la pantalla seguiria mostrando
 * el de antes. Se navega con la MISMA regla que un clic en la barra
 * (`enlaceAOtroTablero`): crear es cambiar a un tablero que antes no existia, y
 * que las dos cosas hagan lo mismo con el filtro y el panel es lo que evita tener
 * que recordar dos reglas.
 *
 * VACIO MUESTRA EL ERROR, a diferencia del QuickAdd, donde un Enter sobre el
 * campo vacio no hace nada. La diferencia es la frecuencia: aquel es un campo que
 * se pulsa sin pensar, en cuatro columnas, todo el dia; este se usa pocas veces y
 * con intencion, asi que un Enter vacio es mas probable que sea una duda que un
 * reflejo, y decirle que falta el nombre la resuelve. Por eso tampoco se corta en
 * el cliente: el mensaje vive en un solo sitio, la accion.
 */
export function NuevoTablero({
  filtros,
}: {
  /** Los de la pantalla: viajan al tablero nuevo como en cualquier cambio de tablero. */
  filtros: Filtros;
}) {
  const router = useRouter();
  const [nombre, setNombre] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Ver `QuickAdd`: cubre la escritura Y la actualizacion del arbol que le sigue. */
  const [enVuelo, iniciar] = useTransition();
  const idError = useId();

  function enviar(): void {
    // Dos Enter seguidos no crean dos tableros. Misma guarda que el QuickAdd, y
    // por lo mismo: una Server Action no tiene `Idempotency-Key` (6.5).
    if (enVuelo) {
      return;
    }

    iniciar(async () => {
      const resultado = await crearTablero({ name: nombre });

      if (!resultado.ok) {
        // El texto se CONSERVA: el caso real es un nombre de mas de 120
        // caracteres, y vaciarlo borraria lo que el mensaje pide recortar.
        setError(
          resultado.requestId === undefined
            ? resultado.mensaje
            : `${resultado.mensaje} (${resultado.requestId})`,
        );

        return;
      }

      // El aviso de `/eventos` de esta creacion es nuestro. Ver `QuickAdd`.
      recordarCambioPropio(resultado.requestId);
      setNombre("");
      setError(null);

      // `push` y no `replace`: el tablero de antes queda en el historial, asi que
      // el boton de atras vuelve a el, igual que despues de un clic en la barra.
      router.push(enlaceAOtroTablero(resultado.valor.id, filtros));
    });
  }

  return (
    <form
      className="barra__nuevo"
      onSubmit={(evento) => {
        evento.preventDefault();
        enviar();
      }}
    >
      <input
        className="barra__nuevo-campo"
        type="text"
        value={nombre}
        placeholder={enVuelo ? "Creando..." : "+ Nuevo tablero"}
        aria-label="Nuevo tablero"
        {...(error === null ? {} : { "aria-invalid": true, "aria-describedby": idError })}
        autoComplete="off"
        onChange={(evento) => {
          setNombre(evento.target.value);

          if (error !== null) {
            setError(null);
          }
        }}
        onKeyDown={(evento) => {
          if (evento.key !== "Escape") {
            return;
          }

          // Descarta lo escrito y no cierra el panel de detalle, que escucha
          // Escape en `document`. Mismo trato que el QuickAdd.
          evento.stopPropagation();
          setNombre("");
          setError(null);
        }}
      />

      {error !== null && (
        <p className="barra__nuevo-error" id={idError} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
