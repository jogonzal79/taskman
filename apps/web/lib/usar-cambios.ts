"use client";

import type { AvisoDeCambio } from "@taskman/core/cambios";
import { useEffect, useRef, useState } from "react";

/**
 * EL LADO DEL NAVEGADOR del aviso de cambios: un `EventSource` contra
 * `/eventos`, y nada mas.
 *
 * `EventSource` y no `fetch` con lectura de flujo: reconecta solo cuando la
 * conexion se corta —el servidor se reinicio, el portatil se durmio— y esa
 * reconexion es exactamente lo que evita que el tablero se quede mudo para
 * siempre despues de un hipo. Con `fetch` habria que escribir ese bucle a mano.
 *
 * NO ABRE NADA MIENTRAS LA PESTAÑA ESTA OCULTA... y si, la abre igual. Es una
 * decision y conviene que se lea: cerrar el flujo al ocultarse ahorraria una
 * conexion ociosa por pestaña de fondo, pero el caso REAL de este paso es
 * justamente ese —el tablero en segundo plano mientras un agente trabaja— y
 * cerrarlo obligaria a recuperar lo perdido al volver. Una conexion ociosa no
 * consulta la base (ver `lib/cambios.ts`), asi que lo que se ahorraria es un
 * socket y lo que se perderia es el caso de uso.
 */

export interface ManejadoresDeCambios {
  /** Llega un cambio, propio o ajeno. */
  alCambiar: (aviso: AvisoDeCambio) => void;
  /**
   * El flujo se (re)conecto.
   *
   * IMPORTA MAS DE LO QUE PARECE: mientras no habia conexion pudo cambiar
   * cualquier cosa, y esos avisos no se guardan en ningun sitio —`NOTIFY` no
   * tiene cola para quien no esta escuchando—. Asi que reconectar significa
   * "puedo estar mostrando algo viejo" y obliga a releer una vez. Es el unico
   * momento en que el cliente refresca sin que nadie se lo pida.
   *
   * Y NO SOLO LO DISPARA UN CORTE DE RED: cuando el servidor pierde su escucha
   * con PostgreSQL, cierra el flujo a proposito (`/eventos`), y la reconexion
   * que sigue es la que pone al tablero al dia con lo escrito mientras estaba
   * sordo.
   */
  alReconectar: () => void;
}

/**
 * Devuelve si el flujo esta CONECTADO ahora mismo.
 *
 * Que ese estado salga del hook —y termine publicado en el DOM, ver
 * `ColumnList`— no es un detalle: el modo de fallo de todo este mecanismo es el
 * SILENCIO. Un tablero desconectado se ve exactamente igual que uno donde no
 * pasa nada, asi que sin este dato no hay forma de distinguir "no cambio nada"
 * de "dejo de enterarse", ni mirando la pantalla ni desde una prueba.
 *
 * CONECTADO QUIERE DECIR ESCUCHANDO LA BASE, no "socket abierto". Se enciende con
 * el `listo`, que el servidor manda cuando su `LISTEN` ya esta puesto, y se apaga
 * cuando el flujo se cierra, que el servidor hace en cuanto ese `LISTEN` se cae.
 * El latido NO cuenta: lo emite el servidor web por su cuenta y siguio llegando
 * con la escucha muerta, que es como este valor llego a mentir.
 */
export function useCambios(manejadores: ManejadoresDeCambios): boolean {
  /**
   * Los manejadores en una ref y no en las dependencias del efecto: cambian de
   * identidad en cada render —son funciones definidas en el cuerpo del
   * componente— y ponerlos como dependencia cerraria y reabriria el
   * `EventSource` en cada render. Con la ref, la suscripcion se abre UNA vez y
   * siempre llama a la version actual.
   */
  const actuales = useRef(manejadores);
  const [conectado, setConectado] = useState(false);

  actuales.current = manejadores;

  useEffect(() => {
    // La primera apertura no es una "reconexion": el arbol que se acaba de
    // renderizar en el servidor ya es fresco, y refrescar ahi seria un render de
    // mas en cada carga de la pagina.
    let yaConectado = false;
    const fuente = new EventSource("/eventos");

    fuente.addEventListener("listo", () => {
      if (yaConectado) {
        actuales.current.alReconectar();
      }

      yaConectado = true;
      setConectado(true);
    });

    fuente.addEventListener("cambio", (evento) => {
      let aviso: AvisoDeCambio;

      try {
        aviso = JSON.parse((evento as MessageEvent<string>).data) as AvisoDeCambio;
      } catch {
        return;
      }

      actuales.current.alCambiar(aviso);
    });

    /**
     * En `onerror` solo se APAGA la bandera. No se cierra la fuente ni se
     * reintenta a mano: `EventSource` ya reintenta solo, y cuando lo consiga
     * llegara un `listo` nuevo, que es donde esta la logica de ponerse al dia.
     * Cerrarla aca seria apagar justamente el reintento.
     */
    fuente.addEventListener("error", () => setConectado(false));

    return () => fuente.close();
  }, []);

  return conectado;
}
