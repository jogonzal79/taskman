"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useMemo, useRef, useState, useTransition } from "react";

import { moverTarea, type OrdenDeColumna } from "../lib/acciones";
import type { Filtros } from "../lib/filtros";
import {
  columnaDe,
  mismoOrden,
  moverEnOrdenVisible,
  posicionParaElNucleo,
  proyectarOrdenDelServidor,
  type OrdenVisible,
} from "../lib/orden";
import { useReordenAnimado } from "../lib/reorden-animado";
import type { ColumnaEnPantalla, TarjetaEnPantalla } from "../lib/tablero";
import { ColumnCard } from "./column-card";
import { TarjetaVisual } from "./task-card";

/**
 * ColumnList (9.3): "Contenedor con scroll horizontal; gestiona el contexto de
 * dnd-kit".
 *
 * Este es el paso en el que esa segunda mitad deja de ser una promesa. El
 * contexto de arrastre vive aca, y con el, TODO el estado de cliente del
 * tablero: el orden visible de cada columna, que tarjeta se esta arrastrando y
 * el ultimo error. El componente estaba separado de la pagina desde el modo
 * lectura exactamente para esto, y por eso la pagina sigue siendo un Server
 * Component que carga datos del nucleo: el limite cliente/servidor cae aca.
 *
 * --- POR QUE NO HAY TANSTACK QUERY ------------------------------------------
 *
 * La 9.1 lo nombra ("TanStack Query gestiona el estado del cliente y la
 * revalidacion. Clave de cache: ['board', boardId]") y NO esta. No es un olvido
 * ni una simplificacion: es que en esta arquitectura no tiene de que ocuparse, y
 * ponerlo crearia el problema que resuelve.
 *
 * TanStack Query es una cache de estado de SERVIDOR sobre una capa de fetch en
 * el navegador. Aca no hay ninguna de las dos cosas:
 *
 *   - La carga inicial es un Server Component que invoca el nucleo (9.1), asi
 *     que el tablero llega como PROPIEDADES, ya renderizado. No hay una peticion
 *     del cliente que cachear ni una clave que sembrar.
 *   - Las mutaciones son Server Actions que invocan los mismos servicios, y la
 *     UI NO consume su propia API publica (9.1). Para que TanStack Query pudiera
 *     refrescar `["board", boardId]` haria falta inventarle un fetcher: o llamar
 *     a la API REST —que exige una API key con scope `write` (7.2), o sea que la
 *     UI tendria que guardar una credencial para hablar consigo misma— o una
 *     Server Action que devuelva el tablero entero, que es exactamente lo que el
 *     render del servidor ya hace.
 *   - La revalidacion ya existe y es `revalidatePath("/")`: invalida la ruta y
 *     Next manda el arbol nuevo junto con la respuesta de la accion.
 *
 * O sea que habria DOS copias del mismo tablero en el navegador —la de las
 * propiedades y la de la cache— y dos caminos para refrescarlas, que habria que
 * mantener sincronizados a mano. Eso no es estado de servidor sin gestionar: es
 * estado de servidor gestionado dos veces.
 *
 * CON QUE SE RESUELVE EN SU LUGAR, pieza por pieza:
 *
 *   - La cache son LAS PROPIEDADES. `revalidatePath` las refresca.
 *   - El "en vuelo" es `useTransition`, que ademas cubre hasta que TERMINA la
 *     actualizacion del arbol y no solo la escritura.
 *   - La actualizacion optimista y su reversion son el `useState` de abajo con
 *     una instantanea, que es literalmente lo que describen los puntos 1 y 4 de
 *     la 9.2.
 *   - Y la reconciliacion —el punto 3, el que decide— NO la podria dar TanStack
 *     Query de todos modos: sale del `MoveResult` que devuelve la accion, que es
 *     el orden releido de la base DENTRO de la transaccion que lo escribio. Una
 *     cache invalidada solo puede volver a preguntar DESPUES, y entre el commit
 *     y esa pregunta cabe otra escritura.
 *
 * El dia que aparezca una pantalla que SI consulte por su cuenta —notificaciones
 * de cambios de agentes, varios tableros a la vez— la decision se vuelve a mirar
 * con un caso concreto delante, que es lo que hoy no hay.
 *
 * --- EL ESTADO Y LAS PROPIEDADES --------------------------------------------
 *
 * `orden` es el estado local: por columna, los ids EN EL ORDEN EN QUE SE PINTAN.
 * Solo ids; los datos de cada tarjeta siguen viniendo de las propiedades. Asi el
 * arrastre no duplica el tablero, solo su orden, que es lo unico que muta.
 *
 * Y SE REINICIA CON CADA RENDER DEL SERVIDOR: `columnas` llega con identidad
 * nueva en cada carga RSC, asi que el ajuste de mas abajo descarta el estado
 * local en cuanto el servidor dice algo. El servidor es la autoridad; el estado
 * local solo existe para el hueco de tiempo en el que todavia no contesto.
 */

/** El orden visible que declaran las propiedades del servidor. */
function ordenDeProps(columnas: readonly ColumnaEnPantalla[]): OrdenVisible {
  const orden: Record<string, readonly string[]> = {};

  for (const columna of columnas) {
    orden[columna.id] = columna.tasks.map((tarea) => tarea.id);
  }

  return orden;
}

/** Donde esta una tarea SEGUN EL SERVIDOR: su columna y su position real. */
interface Ubicacion {
  readonly columnId: string;
  readonly position: number;
}

export function ColumnList({
  boardId,
  columnas,
  hoy,
  tareaAbierta,
  filtros,
}: {
  boardId: string;
  columnas: ColumnaEnPantalla[];
  hoy: Date;
  /**
   * La tarea que el panel esta mostrando, para que su tarjeta se distinga. Pasa
   * de largo como `boardId`: sale del parametro de consulta que ya leyo la
   * pagina, no de un estado de cliente que habria que sincronizar.
   */
  tareaAbierta: string | undefined;
  /** Pasan de largo hasta el enlace de cada tarjeta: abrir el panel no los pierde. */
  filtros: Filtros;
}) {
  const [orden, setOrden] = useState<OrdenVisible>(() => ordenDeProps(columnas));
  const [base, setBase] = useState(columnas);
  const [activa, setActiva] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * CUANTAS VECES la reconciliacion del punto 3 CORRIGIO algo: el orden que
   * devolvio el servidor no era el que habia calculado el navegador.
   *
   * Se publica en el DOM (`data-correcciones`) y NO es instrumentacion de prueba
   * disfrazada: es un dato real del estado de esta pantalla, es lo primero que
   * se mira cuando alguien dice que "una tarjeta se movio sola", y sobre todo es
   * el UNICO observable que distingue "la reconciliacion corrio y no hizo falta
   * corregir nada" de "corrigio".
   *
   * ESO ULTIMO ESTA MEDIDO, no supuesto. Contraprueba hecha al escribir esto:
   * sustituyendo el orden del servidor por el que calculo el navegador —o sea
   * BORRANDO el punto 3— la prueba de extremo a extremo seguia viendo el orden
   * correcto en pantalla y solo fallaba por este contador. El motivo es que la
   * revalidacion llega detras con las propiedades nuevas y tapa el fallo. Sin
   * este numero, el punto 3 se podria borrar entero sin que nada se pusiera rojo.
   */
  const [correcciones, setCorrecciones] = useState(0);
  const [enVuelo, iniciar] = useTransition();

  const contenedor = useRef<HTMLDivElement>(null);
  const marcarReordenAnimado = useReordenAnimado(contenedor);

  /**
   * LA INSTANTANEA DEL PUNTO 1 de la 9.2, tomada AL AGARRAR y no al soltar.
   *
   * La diferencia no es un matiz: `onDragOver` ya movio la tarjeta de columna
   * mientras se arrastraba, asi que el estado que hay en el momento de soltar YA
   * tiene parte del movimiento aplicada. Restaurar ESE estado ante un error
   * dejaria la tarjeta en la columna destino con el movimiento sin escribir, que
   * es exactamente la mentira que el punto 4 existe para evitar.
   *
   * Va en una ref y no en estado porque nada de lo que se pinta depende de ella:
   * es memoria del gesto en curso, y escribirla no tiene que provocar un render.
   */
  const instantanea = useRef<OrdenVisible | null>(null);

  /**
   * EL AJUSTE DE ESTADO CUANDO CAMBIAN LAS PROPIEDADES, hecho durante el render
   * y no en un efecto: asi React lo resuelve antes de pintar y no hay un
   * fotograma con el orden viejo. Es el patron documentado para "derivar estado
   * de propiedades"; con un `useEffect` se veria parpadear cada revalidacion.
   *
   * La comparacion es por IDENTIDAD y no por contenido. Cada carga RSC
   * deserializa un array nuevo, asi que esto se dispara una vez por render del
   * servidor y ni una mas: un `setState` del propio cliente vuelve a entrar aca
   * con la MISMA identidad de `columnas` y no reinicia nada.
   */
  if (base !== columnas) {
    setBase(columnas);
    setOrden(ordenDeProps(columnas));
  }

  /**
   * Los datos de cada tarjeta, por id. Salen de las PROPIEDADES y no del estado:
   * el arrastre cambia el ORDEN, no la tarea.
   *
   * CONSECUENCIA VISIBLE, y es la unica del paso: `vencida` lo calcula el
   * servidor mirando tambien la KEY de la columna (`esVencida`, 6.3.2), asi que
   * arrastrar una tarea vencida a Completado deberia quitarle la marca y no se
   * la quita hasta que llega la revalidacion, unas decenas de milisegundos
   * despues. No se recalcula aca a proposito: esa regla vive en el nucleo y una
   * segunda version en el navegador es exactamente la copia que despues
   * discrepa. Se prefiere una marca correcta un instante tarde a una marca
   * calculada por dos sitios distintos.
   */
  const tarjetas = useMemo(() => {
    const porId = new Map<string, TarjetaEnPantalla>();

    for (const columna of columnas) {
      for (const tarea of columna.tasks) {
        porId.set(tarea.id, tarea);
      }
    }

    return porId;
  }, [columnas]);

  /**
   * Donde esta cada tarea SEGUN EL SERVIDOR. Es lo que traduce el indice visible
   * al `position` real (ver `lib/orden.ts`), y por eso sale de las PROPIEDADES y
   * nunca del estado local: el estado local es lo que el navegador supone, y
   * suponer una position es justo lo que no se puede hacer.
   *
   * Que este al dia en el momento de soltar lo garantiza `bloqueado`: mientras
   * hay un movimiento en vuelo no se puede empezar otro, y `enVuelo` no baja
   * hasta que la revalidacion trajo las positions nuevas.
   */
  const ubicaciones = useMemo(() => {
    const porId = new Map<string, Ubicacion>();

    for (const columna of columnas) {
      for (const tarea of columna.tasks) {
        porId.set(tarea.id, { columnId: columna.id, position: tarea.position });
      }
    }

    return porId;
  }, [columnas]);

  const sensores = useSensors(
    /**
     * LA RESTRICCION DE DISTANCIA ES LO QUE DEJA CONVIVIR el arrastre con el
     * enlace de la tarjeta: por debajo de 6 px el gesto es un clic y abre el
     * panel; a partir de ahi es un arrastre, y dnd-kit se encarga de que el clic
     * final no llegue a React.
     *
     * Seis y no dos: un clic con raton se mueve uno o dos pixeles casi siempre.
     */
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      /**
       * SOLO ESPACIO empieza y termina el arrastre; el Enter que dnd-kit trae
       * por defecto se saca a proposito, porque el asa vive DENTRO de una
       * tarjeta que es un enlace y Enter tiene que seguir siendo "abrir".
       * Dejando los dos, la misma tecla haria dos cosas segun donde este el foco.
       */
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  /**
   * Que hay DEBAJO del puntero, resuelto con preferencia por las TARJETAS.
   *
   * Cada columna tiene dos destinos superpuestos: sus tarjetas y el `<ul>` que
   * las contiene (que es el que hace posible soltar en una columna vacia). Con
   * la deteccion por defecto, la columna entera compite con sus propias
   * tarjetas y gana segun la geometria, asi que soltar sobre la tercera tarjeta
   * a veces mandaria la tarea AL FINAL. Prefiriendo tarjetas, la columna solo
   * gana cuando de verdad no hay ninguna debajo: el hueco de una columna vacia o
   * el espacio libre bajo la ultima tarjeta.
   */
  const detectarColisiones: CollisionDetection = (args) => {
    const debajo = pointerWithin(args);
    const tarjetasDebajo = debajo.filter(
      (colision) =>
        args.droppableContainers.find((destino) => destino.id === colision.id)?.data.current?.[
          "tipo"
        ] === "tarea",
    );

    if (tarjetasDebajo.length > 0) {
      return tarjetasDebajo;
    }

    // Fuera de toda columna —el hueco entre dos, el margen de la pagina— no hay
    // nada bajo el puntero y se cae a la columna que mas solape la tarjeta.
    return debajo.length > 0 ? debajo : rectIntersection(args);
  };

  /** La columna a la que apunta un destino, sea una tarjeta o la columna misma. */
  function columnaDelDestino(id: UniqueIdentifier | undefined): string | undefined {
    if (id === undefined) {
      return undefined;
    }

    const texto = String(id);

    return columnaDe(orden, texto) ?? (orden[texto] === undefined ? undefined : texto);
  }

  function alEmpezar(evento: DragStartEvent): void {
    instantanea.current = orden;
    setActiva(String(evento.active.id));
    // Un error viejo no describe el arrastre que empieza.
    setError(null);
  }

  /**
   * CANCELAR (Escape, o soltar fuera de la ventana) deshace tambien lo que
   * `onDragOver` aplico. Sin esto, un Escape a mitad de camino dejaria la
   * tarjeta en la columna nueva sin haber escrito nada: la pantalla afirmaria un
   * movimiento que no ocurrio, que es el mismo fallo que el punto 4 evita
   * cuando la accion falla.
   */
  function alCancelar(): void {
    const previo = instantanea.current;

    setActiva(null);

    if (previo !== null) {
      setOrden(previo);
      instantanea.current = null;
    }
  }

  /**
   * EL CAMBIO DE COLUMNA SE APLICA MIENTRAS SE ARRASTRA, no al soltar: es lo que
   * hace que la tarjeta se vea entrar en la columna destino, con el hueco
   * abriendose, en vez de saltar al final del gesto.
   *
   * Y SOLO el cambio de columna. Reordenar DENTRO de una columna no toca el
   * estado: de eso se encarga `SortableContext`, que desplaza las tarjetas con
   * transformaciones sin cambiar el orden real. Meter mano ahi es la receta del
   * parpadeo clasico de dnd-kit —se reordena, cambia el alto, el puntero queda
   * sobre otra tarjeta, se reordena de vuelta— y ademas no haria falta.
   */
  function alPasarPorEncima(evento: DragOverEvent): void {
    const { active, over } = evento;

    if (over === null) {
      return;
    }

    const idActiva = String(active.id);
    const origen = columnaDe(orden, idActiva);
    const destino = columnaDelDestino(over.id);

    if (origen === undefined || destino === undefined || origen === destino) {
      return;
    }

    const lista = orden[destino] ?? [];
    const sobreTarjeta = lista.indexOf(String(over.id));
    // Sobre una tarjeta, la tarea entra EN SU LUGAR y la empuja hacia abajo;
    // sobre el hueco de la columna, entra al final de lo que se ve.
    const indice = sobreTarjeta < 0 ? lista.length : sobreTarjeta;

    setOrden((previo) => moverEnOrdenVisible(previo, idActiva, destino, indice));
  }

  /**
   * SOLTAR. Los cuatro momentos de la 9.2 estan aca, en este orden y sin nada
   * entre medio.
   */
  function alSoltar(evento: DragEndEvent): void {
    const { active, over } = evento;
    /** PUNTO 1 de la 9.2, primera mitad: la instantanea, tomada al agarrar. */
    const previo = instantanea.current ?? orden;

    instantanea.current = null;
    setActiva(null);

    if (over === null) {
      // Soltada fuera de toda columna: se cancela igual que con Escape. Escribir
      // un movimiento que nadie apunto a ningun sitio seria peor que no hacer nada.
      setOrden(previo);

      return;
    }

    const idActiva = String(active.id);
    const destino = columnaDelDestino(over.id);
    const ubicacion = ubicaciones.get(idActiva);

    if (destino === undefined || ubicacion === undefined) {
      setOrden(previo);

      return;
    }

    const lista = orden[destino] ?? [];
    const sobreTarjeta = lista.indexOf(String(over.id));
    const indice = sobreTarjeta < 0 ? lista.length : sobreTarjeta;

    /** PUNTO 1, segunda mitad: el estado local se reordena DE INMEDIATO. */
    const optimista = moverEnOrdenVisible(orden, idActiva, destino, indice);
    const destinoFinal = optimista[destino] ?? [];

    const posicion = posicionParaElNucleo({
      destinoFinal,
      taskId: idActiva,
      mismaColumna: ubicacion.columnId === destino,
      posiciones: new Map([...ubicaciones].map(([id, donde]) => [id, donde.position] as const)),
    });

    /**
     * Nada que escribir: la tarea termino en la misma columna y en el mismo
     * sitio del que salio. Se compara contra la INSTANTANEA —lo que habia antes
     * de agarrar— y no contra el estado actual, que ya tiene el gesto aplicado.
     *
     * El nucleo lo aceptaria igual (MOVE se registra tambien cuando la tarea
     * termina donde estaba, ver `TaskService.move`), y por eso hace falta
     * cortarlo aca: cada tarjeta agarrada y soltada sin querer dejaria una fila
     * en `audit_log` y reescribiria la columna entera.
     */
    if (ubicacion.columnId === destino && mismoOrden(destinoFinal, previo[destino] ?? [])) {
      setOrden(previo);

      return;
    }

    setOrden(optimista);

    /** PUNTO 2: se invoca la accion. La respuesta trae el orden autoritativo. */
    iniciar(async () => {
      const resultado = await moverTarea(idActiva, { columnId: destino, position: posicion });

      if (!resultado.ok) {
        /**
         * PUNTO 4: se restaura la instantanea y se muestra el mensaje del error
         * de dominio.
         *
         * La vuelta atras tambien se ANIMA. Es un movimiento tan real como el de
         * ida y, si se aplicara de golpe, la tarjeta reapareceria en su sitio
         * viejo al mismo tiempo que sale el aviso: se leeria como si el aviso
         * hubiera movido la tarjeta, en vez de como que el movimiento se deshizo.
         */
        marcarReordenAnimado();
        setOrden(previo);
        setError(
          resultado.requestId === undefined
            ? resultado.mensaje
            : `${resultado.mensaje} (${resultado.requestId})`,
        );

        return;
      }

      /**
       * PUNTO 3: el estado local se SUSTITUYE por el orden del servidor. No se
       * conserva el calculado localmente ni se comparan los dos para quedarse
       * con "el que parezca mejor": se sustituye, y punto.
       */
      const corregido = aplicarOrdenDelServidor(optimista, resultado.valor.columnas);

      if (huboCorreccion(optimista, corregido, resultado.valor.columnas)) {
        // Que se VEA. Ver `useReordenAnimado`: una tarjeta que salta sin motivo
        // se lee como un fallo del arrastre.
        marcarReordenAnimado();
        setCorrecciones((previas) => previas + 1);
      }

      setOrden(corregido);
    });
  }

  /**
   * Mientras hay un movimiento en vuelo no se empieza otro, y no es por
   * prudencia: es que `ubicaciones` —las positions REALES, con las que se
   * traduce donde se solto— sale de las propiedades, y entre que la accion
   * escribe y la revalidacion las trae, las de la pantalla ya no son las de la
   * base. Un segundo arrastre en esa rendija se calcularia contra numeros
   * viejos y dejaria la tarea un lugar corrida, sin ningun error.
   *
   * La rendija dura lo que la transaccion mas el viaje, o sea decenas de
   * milisegundos. Se prefiere que las tarjetas no se dejen agarrar —lo que se ve
   * y se entiende— antes que aceptar el gesto y descartarlo al final.
   */
  const bloqueado = enVuelo;
  const arrastrada = activa === null ? undefined : tarjetas.get(activa);

  /**
   * LO QUE OYE quien navega con lector de pantalla.
   *
   * dnd-kit trae textos por defecto EN INGLES, y una pantalla en espanol no
   * puede anunciarse en otro idioma. Ademas los suyos hablan de "posicion N de
   * M" sobre una lista abstracta, y aca lo que significa algo es la COLUMNA.
   *
   * Se arman aca dentro y no como constante de modulo porque necesitan
   * `tarjetas` para decir el TITULO: los identificadores de dnd-kit son los ids
   * de las tareas, o sea UUID, y anunciar "agarraste la tarea 4f3c…" no le sirve
   * a nadie.
   *
   * `onDragOver` devuelve `undefined` a proposito: se dispara en cada pixel, y
   * un lector de pantalla leyendo una frase por pixel es ruido que tapa el
   * anuncio que si importa.
   */
  const anuncios: Announcements = {
    onDragStart: ({ active }) =>
      `Agarraste ${titulo(tarjetas, active.id)}. Movela con las flechas.`,
    onDragOver: () => undefined,
    onDragEnd: ({ active }) => `Soltaste ${titulo(tarjetas, active.id)}. Guardando el movimiento.`,
    onDragCancel: ({ active }) =>
      `Cancelaste el movimiento de ${titulo(tarjetas, active.id)}. Vuelve a su sitio.`,
  };

  return (
    <DndContext
      sensors={sensores}
      collisionDetection={detectarColisiones}
      onDragStart={alEmpezar}
      onDragOver={alPasarPorEncima}
      onDragEnd={alSoltar}
      onDragCancel={alCancelar}
      accessibility={{ announcements: anuncios, screenReaderInstructions: INSTRUCCIONES }}
    >
      {/*
        EL AVISO DE ERROR, con `role="alert"` para que se anuncie sin mover el
        foco. Va arriba del tablero y no sobre la tarjeta: cuando falla, la
        tarjeta ya volvio a su sitio, asi que no hay ninguna a la que colgarselo.
      */}
      {error !== null && (
        <p className="aviso-movimiento" role="alert">
          {error}
        </p>
      )}

      <div className="columnas" ref={contenedor} data-correcciones={correcciones}>
        {columnas.map((columna) => (
          <ColumnCard
            key={columna.id}
            boardId={boardId}
            columna={columna}
            /*
              Del ESTADO LOCAL, no de `columna.tasks`: durante un arrastre y
              hasta que responde la accion, el orden que vale es el de aca. Los
              DATOS de cada tarjeta siguen saliendo de las propiedades.

              El `flatMap` descarta los ids sin tarjeta. Pasa en una sola
              situacion, y es sana: la reconciliacion trajo del servidor una
              tarea que este cliente no conoce —creada por un agente mientras la
              pantalla estaba abierta— y no hay con que dibujarla hasta que la
              revalidacion traiga sus datos.
            */
            tareas={(orden[columna.id] ?? []).flatMap((id) => {
              const tarjeta = tarjetas.get(id);

              return tarjeta === undefined ? [] : [tarjeta];
            })}
            bloqueado={bloqueado}
            hoy={hoy}
            tareaAbierta={tareaAbierta}
            filtros={filtros}
          />
        ))}
      </div>

      {/*
        LA COPIA QUE VIAJA CON EL PUNTERO. Sin ella, la tarjeta arrastrada
        seguiria dentro del `<ul>` que desplaza y se recortaria al salir de su
        columna, que es justo el movimiento que hay que poder hacer. Se renderiza
        con el MISMO componente que la tarjeta real para que no haya un salto
        visual al agarrarla.
      */}
      <DragOverlay>
        {arrastrada === undefined ? null : (
          <div className="tarjeta-volando">
            <TarjetaVisual tarea={arrastrada} hoy={hoy} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Sustituye el orden de las columnas afectadas por el que devolvio el servidor,
 * proyectado sobre lo que la pantalla puede dibujar.
 *
 * Las columnas que NO estan en `affectedColumns` se dejan como estaban: el
 * movimiento no las toco, asi que el servidor no dijo nada de ellas.
 */
function aplicarOrdenDelServidor(
  actual: OrdenVisible,
  columnas: readonly OrdenDeColumna[],
): OrdenVisible {
  const corregido: Record<string, readonly string[]> = { ...actual };

  for (const columna of columnas) {
    corregido[columna.columnId] = proyectarOrdenDelServidor(
      columna.taskOrder,
      actual[columna.columnId] ?? [],
    );
  }

  return corregido;
}

/** Si el servidor contradijo al navegador en alguna de las columnas afectadas. */
function huboCorreccion(
  optimista: OrdenVisible,
  corregido: OrdenVisible,
  columnas: readonly OrdenDeColumna[],
): boolean {
  return columnas.some(
    (columna) =>
      !mismoOrden(optimista[columna.columnId] ?? [], corregido[columna.columnId] ?? []),
  );
}

/** El titulo de una tarjeta para anunciarla, o el id si ya no esta en pantalla. */
function titulo(tarjetas: ReadonlyMap<string, TarjetaEnPantalla>, id: UniqueIdentifier): string {
  return tarjetas.get(String(id))?.title ?? String(id);
}

const INSTRUCCIONES = {
  draggable:
    "Pulsa Espacio para agarrar la tarea. Con las flechas la moves entre posiciones y entre columnas. Espacio otra vez la suelta; Escape cancela.",
};
