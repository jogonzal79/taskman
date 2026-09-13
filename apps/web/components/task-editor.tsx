"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";

import { borrarTarea, editarTarea, type CamposDeTarea } from "../lib/acciones";
import { PRIORIDADES, type OpcionDePrioridad } from "../lib/prioridad";

/**
 * La superficie EDITABLE del TaskDetailPanel (9.3): "Panel lateral de edicion;
 * guardado por campo al perder el foco."
 *
 * Es cliente porque tres cosas lo exigen y ninguna se puede resolver en el
 * servidor: el estado de cada campo mientras se escribe, el guardado al PERDER
 * EL FOCO (que es un evento del DOM) y la tecla Escape. El resto del panel
 * —cabecera, nombre de la columna, enlace de cierre— lo dibuja
 * `TaskDetailPanel`, que sigue siendo de servidor.
 *
 * LO QUE CRUZA AL CLIENTE son los cuatro campos editables de UNA tarea y su id.
 * No el tablero, no las otras tarjetas, no la columna: solo su nombre, y solo
 * para mostrarlo. Es el mismo criterio que `QuickAdd`.
 *
 * SIN BOTON DE GUARDAR, como pide la 9.3. Cada campo se guarda solo al perder el
 * foco, y eso obliga a una decision que no es obvia: QUE hacer cuando el valor no
 * cambio. Ver `guardar`.
 */

/**
 * Lo que el panel necesita de la tarea. Son exactamente los cuatro campos que la
 * 5.2 declara editables mas el id: `position` y `columnId` no estan porque
 * requieren move, y no tenerlos aca es lo que hace imposible mandarlos por error.
 */
export interface TareaEditable {
  id: string;
  title: string;
  description: string | null;
  priority: OpcionDePrioridad;
  /** `AAAA-MM-DD` leido en UTC, o cadena vacia si no tiene vencimiento. */
  dueDate: string;
}

export function TaskEditor({
  tarea,
  columnName,
}: {
  tarea: TareaEditable;
  /** Solo para mostrar de que columna es. Cambiarla requiere move (5.2). */
  columnName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [enVuelo, iniciar] = useTransition();
  /**
   * El borrado ARMADO: el boton pide un segundo clic. Ver el comentario de
   * `BotonBorrar` mas abajo para por que esta es la forma de confirmar que le
   * corresponde a esta superficie.
   */
  const [armado, setArmado] = useState(false);
  const idError = useId();

  /** Cierra el panel volviendo a la ruta sin el parametro de consulta. */
  function cerrar(): void {
    router.push("/", { scroll: false });
  }

  /**
   * ESCAPE, con DOS niveles y en este orden: si el borrado esta armado lo
   * desarma, y si no, cierra el panel. El orden importa —lo mas peligroso se
   * deshace primero— y evita que un Escape dado para cerrar deje un boton armado
   * esperando un clic distraido.
   *
   * Va en `document` y no en un `onKeyDown` del `<aside>` porque tiene que
   * funcionar tambien cuando el foco no esta dentro del panel; el listener vive
   * mientras el panel esta montado y se va con el.
   *
   * CERRAR DESCARTA lo que se este escribiendo en el campo enfocado: React no
   * dispara `blur` al desmontar, asi que ese guardado no ocurre. Es a proposito y
   * es lo que Escape ya significa en el QuickAdd —descarta lo que estoy
   * haciendo— asi que la tecla no cambia de sentido entre las dos superficies.
   */
  useEffect(() => {
    function alTeclear(evento: KeyboardEvent): void {
      if (evento.key !== "Escape") {
        return;
      }

      if (armado) {
        setArmado(false);

        return;
      }

      cerrar();
    }

    document.addEventListener("keydown", alTeclear);

    return () => document.removeEventListener("keydown", alTeclear);
    // `cerrar` usa `router`, que es estable; `armado` decide cual de los dos
    // niveles aplica, asi que el listener se vuelve a colgar cuando cambia.
  }, [armado, router]);

  /**
   * Guarda UN campo. El patch que sale de aca tiene una sola clave, y esa clave
   * ESTA PRESENTE: eso es lo que distingue "borrar la descripcion" de "no
   * tocarla", porque la ausencia de la clave es lo que el nucleo lee como "no la
   * toques" (`patch.description === undefined`).
   *
   * `cambios` lo arma cada campo con su propia conversion, porque la conversion
   * es distinta en cada uno y es justo donde esta el riesgo:
   *
   *   - Titulo: cadena tal cual. El recorte y el limite los aplica el nucleo.
   *   - Descripcion: vacia -> `null`. Un campo de texto vacio es "borrala", no
   *     "dejala en cadena vacia". Mandar `""` compilaria igual y guardaria una
   *     cadena vacia donde tenia que quedar NULL, y en pantalla se veria
   *     identico: es el colapso que solo se detecta por SQL.
   *   - Fecha: vacia -> `null`, y con valor la CADENA `AAAA-MM-DD` sin
   *     convertirla. Nunca un `new Date(...)` de este lado: la zona local es
   *     UTC-4 y construir la fecha aca la correria un dia.
   *   - Prioridad: siempre uno de los cuatro valores, nunca nula.
   */
  function guardar(cambios: CamposDeTarea): void {
    if (enVuelo) {
      return;
    }

    iniciar(async () => {
      const resultado = await editarTarea(tarea.id, cambios);

      setError(
        resultado.ok
          ? null
          : resultado.requestId === undefined
            ? resultado.mensaje
            : `${resultado.mensaje} (${resultado.requestId})`,
      );
    });
  }

  function borrar(): void {
    if (enVuelo) {
      return;
    }

    iniciar(async () => {
      const resultado = await borrarTarea(tarea.id);

      if (resultado.ok) {
        // La tarea ya no existe, asi que el panel no tiene nada que mostrar.
        // `ubicarEnVista` tambien lo resolveria —un id que no esta en el tablero
        // no abre panel— pero cerrar explicitamente evita que el parametro de
        // consulta se quede en la barra de direcciones apuntando a nada.
        cerrar();

        return;
      }

      setArmado(false);
      setError(resultado.mensaje);
    });
  }

  return (
    <div className="panel__cuerpo">
      <CampoTexto
        etiqueta="Titulo"
        valorInicial={tarea.title}
        multilinea={false}
        // El titulo NO es nullable: vaciarlo no lo borra, lo rechaza el nucleo
        // con TITLE_REQUIRED, y el mensaje aparece abajo.
        alGuardar={(valor) => guardar({ title: valor })}
      />

      <CampoTexto
        etiqueta="Descripcion"
        valorInicial={tarea.description ?? ""}
        multilinea
        // VACIA ES `null`, y esta es la linea que decide el paso: sin esta
        // conversion no habria forma de pedir que se borre.
        alGuardar={(valor) => guardar({ description: valor === "" ? null : valor })}
      />

      <CampoPrioridad
        valor={tarea.priority}
        // Un `<select>` no necesita esperar al blur: el cambio ES la intencion, y
        // ademas el navegador no dispara `change` si se vuelve a elegir la misma
        // opcion, asi que no hay caso "sin cambio" que filtrar.
        alCambiar={(priority) => guardar({ priority })}
      />

      <CampoTexto
        etiqueta="Fecha limite"
        valorInicial={tarea.dueDate}
        multilinea={false}
        tipo="date"
        // Igual que la descripcion: vacia es `null`, o sea quitar el vencimiento.
        // El valor de un `<input type="date">` es `AAAA-MM-DD` en cualquier
        // configuracion regional, asi que viaja como cadena sin tocarlo.
        alGuardar={(valor) => guardar({ dueDate: valor === "" ? null : valor })}
      />

      <p className="panel__columna">
        En <strong>{columnName}</strong>. Cambiar de columna o de posicion no se
        hace desde aca (5.2).
      </p>

      {error !== null && (
        <p className="panel__error" id={idError} role="alert">
          {error}
        </p>
      )}

      <BotonBorrar
        armado={armado}
        enVuelo={enVuelo}
        titulo={tarea.title}
        alArmar={() => {
          setArmado(true);
          setError(null);
        }}
        alCancelar={() => setArmado(false)}
        alConfirmar={borrar}
      />
    </div>
  );
}

/**
 * Un campo que se guarda AL PERDER EL FOCO (9.3), y solo si cambio.
 *
 * EL "SOLO SI CAMBIO" ES DEL CLIENTE Y NO ES LA REGLA. La regla de la 5.2 —"si
 * el patch no produce cambio efectivo, la operacion es exitosa y no genera
 * registro de auditoria"— vive en `TaskService.update`, que compara los cuatro
 * campos y decide. Esta comparacion de aca solo ahorra el viaje: sin ella,
 * recorrer el panel con el tabulador dispararia cuatro guardados y cuatro
 * revalidaciones para no cambiar nada. Las dos cosas coinciden hoy y no es
 * problema que coincidan: si esta se olvidara, el nucleo seguiria sin auditar.
 *
 * Y hay un caso en que NO coinciden, que es el que prueba que la regla del nucleo
 * hace falta igual: escribir el mismo titulo con un espacio de mas al final. Esta
 * comparacion ve dos cadenas distintas y manda el patch; el nucleo recorta,
 * encuentra el mismo valor y no audita.
 *
 * `valorInicial` es el valor RENDERIZADO por el servidor, y se usa como `key`
 * implicita del estado: cuando una revalidacion trae un valor nuevo, el
 * componente se remonta con el (ver el `key` en `TaskDetailPanel`). Sin eso, un
 * cambio hecho por un agente por MCP no se veria en un campo ya montado.
 */
function CampoTexto({
  etiqueta,
  valorInicial,
  multilinea,
  tipo,
  alGuardar,
}: {
  etiqueta: string;
  valorInicial: string;
  multilinea: boolean;
  tipo?: "text" | "date";
  alGuardar: (valor: string) => void;
}) {
  const [valor, setValor] = useState(valorInicial);
  const id = useId();

  function alPerderElFoco(): void {
    if (valor === valorInicial) {
      return;
    }

    alGuardar(valor);
  }

  const comunes = {
    id,
    className: "panel__control",
    value: valor,
    onChange: (evento: { target: { value: string } }) => setValor(evento.target.value),
    onBlur: alPerderElFoco,
  };

  return (
    <div className="panel__campo">
      <Etiqueta id={id}>{etiqueta}</Etiqueta>
      {multilinea ? (
        <textarea {...comunes} rows={5} />
      ) : (
        <input {...comunes} type={tipo ?? "text"} />
      )}
    </div>
  );
}

function CampoPrioridad({
  valor,
  alCambiar,
}: {
  valor: OpcionDePrioridad;
  alCambiar: (valor: OpcionDePrioridad) => void;
}) {
  const id = useId();

  return (
    <div className="panel__campo">
      <Etiqueta id={id}>Prioridad</Etiqueta>
      <select
        id={id}
        className="panel__control"
        defaultValue={valor}
        onChange={(evento) => alCambiar(evento.target.value as OpcionDePrioridad)}
      >
        {PRIORIDADES.map((opcion) => (
          <option key={opcion.valor} value={opcion.valor}>
            {opcion.texto}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * La etiqueta va ASOCIADA POR `htmlFor`, como HERMANA del control y no
 * envolviendolo. La diferencia no es de estilo y se paga en accesibilidad: el
 * nombre accesible de un control envuelto por un `<label>` es TODO el texto del
 * label, y el contenido de un `<textarea>` y las `<option>` de un `<select>` son
 * texto que esta DENTRO.
 *
 * MEDIDO al escribir esto: con los tres controles envueltos, `label.textContent`
 * daba "Titulo" para el campo de texto —el `value` de un input no es contenido—
 * pero "Descripcionb" para el area y "Prioridadx" para el selector. O sea que un
 * lector de pantalla habria anunciado el area de descripcion como "Descripcion"
 * seguido de la descripcion entera, y el selector como "Prioridad Urgente Alta
 * Media Baja". Lo destapo una prueba que buscaba el campo por su etiqueta y no lo
 * encontraba; sin esa prueba, el defecto se veia bien en pantalla.
 */
function Etiqueta({ id, children }: { id: string; children: string }) {
  return (
    <label className="panel__etiqueta" htmlFor={id}>
      {children}
    </label>
  );
}

/**
 * El borrado, en DOS PASOS sobre el propio boton.
 *
 * POR QUE CONFIRMA, y por que asi. Las otras dos superficies protegen el borrado
 * de formas que no se pueden trasladar: el borde REST exige el scope `delete`
 * (6.2), que es una comprobacion de PERMISO —puede este cliente borrar— y no una
 * confirmacion; y la herramienta MCP exige `confirm: true` (8.3.2) para forzar un
 * dialogo de dos pasos en el que el agente PRESENTA la tarea que desapareceria
 * antes de reintentar. La UI no es ninguna de las dos: no hay clave que
 * autorizar, y la informacion que el agente tiene que ir a buscar y mostrar ya
 * esta en la pantalla, porque el panel entero ES el detalle de la tarea.
 *
 * Asi que lo que se traslada de la 8.3.2 no es el parametro sino su FORMA: la
 * intencion se declara dos veces, y entre las dos se ve que se va a perder. Un
 * segundo clic sobre un boton que ahora dice el titulo de la tarea es
 * exactamente eso.
 *
 * DESCARTADO `window.confirm`, y no por estetica: bloquea el hilo, no se puede
 * dar estilo, y sobre todo deja la pagina sin responder a nada mas hasta que
 * alguien lo cierre, lo que rompe cualquier automatizacion del navegador —las
 * propias pruebas de este paso incluidas—.
 *
 * DESCARTADO el borrado directo con "deshacer": es la mejor de todas y no se
 * puede hoy. `TaskService.delete` borra la fila de verdad, asi que deshacer
 * exigiria borrado logico en el nucleo, y eso es un cambio de modelo de datos y
 * no un paso de UI.
 *
 * Lo que NO es: un borrado silencioso. Se arma, se lee el titulo, se confirma; y
 * si algo falla, el mensaje aparece arriba en vez de desaparecer la tarjeta.
 */
function BotonBorrar({
  armado,
  enVuelo,
  titulo,
  alArmar,
  alCancelar,
  alConfirmar,
}: {
  armado: boolean;
  enVuelo: boolean;
  titulo: string;
  alArmar: () => void;
  alCancelar: () => void;
  alConfirmar: () => void;
}) {
  if (!armado) {
    return (
      <div className="panel__borrado">
        <button type="button" className="boton boton--peligro-suave" onClick={alArmar}>
          Borrar tarea
        </button>
      </div>
    );
  }

  return (
    <div className="panel__borrado" role="group" aria-label="Confirmar borrado">
      {/* El titulo va EN la confirmacion: es lo que convierte el segundo clic en
          una decision sobre algo concreto y no en un reflejo. */}
      <p className="panel__aviso-borrado">
        Se va a borrar <strong>{titulo}</strong>. No se puede deshacer.
      </p>
      <div className="panel__botones">
        <button
          type="button"
          className="boton boton--peligro"
          onClick={alConfirmar}
          disabled={enVuelo}
        >
          {enVuelo ? "Borrando..." : "Si, borrar"}
        </button>
        <button type="button" className="boton" onClick={alCancelar} disabled={enVuelo}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
