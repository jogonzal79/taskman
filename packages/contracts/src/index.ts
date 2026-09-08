// Esquemas Zod del borde HTTP: la unica definicion del contrato (ADR-006). Los
// tipos de TypeScript salen por inferencia de los esquemas, nunca escritos a
// mano, para que no puedan desfasarse.
//
// Este paquete es una HOJA del grafo de dependencias (3.3): no importa nada del
// proyecto.

export { consultaDeListado, listadoDe, LIMITE_DEFECTO, LIMITE_MAXIMO } from "./pagination.js";
export type { ConsultaDeListado } from "./pagination.js";

export {
  columnaDetallada,
  crearTablero,
  listadoDeTableros,
  parametrosDeTablero,
  tablero,
  tableroDetallado,
  LIMITE_DESCRIPCION_TABLERO,
  LIMITE_NOMBRE_TABLERO,
} from "./board.js";
export type {
  ColumnaDetallada,
  CrearTablero,
  ListadoDeTableros,
  ParametrosDeTablero,
  Tablero,
  TableroDetallado,
} from "./board.js";
