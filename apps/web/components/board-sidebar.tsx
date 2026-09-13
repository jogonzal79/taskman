import type { TableroEnBarra } from "../lib/tablero";

/**
 * La barra lateral de tableros.
 *
 * La 9.3 no la nombra: pone el "selector de tablero" dentro de BoardHeader. Se
 * separa igual porque en lectura no es un selector —no se puede cambiar de
 * tablero— sino una LISTA que dice cuales hay y cual se esta viendo, y porque es
 * el ARMAZON: si la pagina naciera sin ella, el layout se rehace el dia que entre.
 * Lo que no tiene, a proposito: no navega y no crea tableros. Las dos son
 * interactividad y entran con ella; un control que no hace nada es peor que no
 * tenerlo.
 *
 * Por eso los items son `<li>` y no `<a>`: nada aca es pulsable todavia, y
 * marcarlos como enlaces prometeria lo contrario al teclado y al lector de
 * pantalla. El activo lleva `aria-current`, que es como se dice "este es el que
 * estas viendo" sin depender de que el peso y el fondo se vean.
 */
export function BoardSidebar({
  tableros,
  omitidos,
}: {
  tableros: TableroEnBarra[];
  omitidos: number;
}) {
  return (
    <nav className="barra" aria-label="Tableros">
      <h2 className="barra__titulo">Tableros</h2>
      <ul className="barra__lista">
        {tableros.map((tablero) => (
          <li
            key={tablero.id}
            className={tablero.activo ? "barra__item barra__item--activo" : "barra__item"}
            title={tablero.name}
            {...(tablero.activo ? { "aria-current": "true" as const } : {})}
          >
            {tablero.name}
          </li>
        ))}
        {omitidos > 0 && <li className="barra__resto">y mas sin mostrar</li>}
      </ul>
    </nav>
  );
}
