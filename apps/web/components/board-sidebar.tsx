import Link from "next/link";

import { enlaceAOtroTablero, type Filtros } from "../lib/filtros";
import type { TableroEnBarra } from "../lib/tablero";
import { NuevoTablero } from "./new-board";

/**
 * La barra lateral de tableros: el SELECTOR de tablero y la creacion de uno.
 *
 * La 9.3 pone el "selector de tablero" dentro de BoardHeader, y aca vive en la
 * barra. No es un cambio de sitio caprichoso: la barra existia desde el modo
 * lectura como la LISTA de tableros, y un selector no es mas que esa lista
 * pulsable. Meterlo en la cabecera obligaria a un desplegable, o sea a esconder
 * los otros tableros detras de un clic para ahorrar un ancho que la barra ya
 * ocupa. (Declarado en CLAUDE.md, junto a lo demas de BoardHeader.)
 *
 * LOS ITEMS SON ENLACES, y antes eran `<li>` sueltos a proposito: estaba escrito
 * que marcarlos como enlaces prometeria al teclado y al lector de pantalla algo
 * que no cumplian. Ahora lo cumplen, y por eso son `<a>` de verdad y no botones:
 * elegir un tablero es NAVEGAR —cambia la URL, se puede abrir en otra pestana con
 * el boton del medio, y el boton de atras vuelve al anterior—.
 *
 * EL ACTIVO LLEVA `aria-current="page"` y no "true", que es lo que llevaba
 * cuando era un `<li>`. En un enlace, "page" es el valor que un lector de pantalla
 * anuncia como "pagina actual", y es lo que es: la URL de ese item es la que se
 * esta viendo. El peso y el fondo lo repiten para quien ve.
 *
 * A DONDE LLEVA CADA ITEM lo decide `enlaceAOtroTablero`: con los filtros puestos
 * y sin el panel abierto. El motivo de cada mitad esta escrito ahi, una vez.
 *
 * "NUEVO TABLERO" VA DENTRO DE LA MISMA NAVEGACION, al pie de la lista y fuera del
 * `<ul>`: no es un tablero, asi que no es un item, pero quien recorre los
 * landmarks buscando los tableros lo encuentra donde los busca. Ver
 * `NuevoTablero` para por que es un campo y no un boton.
 */
export function BoardSidebar({
  tableros,
  omitidos,
  filtros,
}: {
  tableros: TableroEnBarra[];
  omitidos: number;
  filtros: Filtros;
}) {
  return (
    <nav className="barra" aria-label="Tableros">
      <h2 className="barra__titulo">Tableros</h2>
      <ul className="barra__lista">
        {tableros.map((tablero) => (
          <li key={tablero.id}>
            <Link
              className={tablero.activo ? "barra__item barra__item--activo" : "barra__item"}
              href={enlaceAOtroTablero(tablero.id, filtros)}
              title={tablero.name}
              {...(tablero.activo ? { "aria-current": "page" as const } : {})}
            >
              {tablero.name}
            </Link>
          </li>
        ))}
        {omitidos > 0 && <li className="barra__resto">y mas sin mostrar</li>}
      </ul>
      <NuevoTablero filtros={filtros} />
    </nav>
  );
}
