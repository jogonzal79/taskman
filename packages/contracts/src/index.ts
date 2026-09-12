// Esquemas Zod del borde HTTP: la unica definicion del contrato (ADR-006). Los
// tipos de TypeScript salen por inferencia de los esquemas, nunca escritos a
// mano, para que no puedan desfasarse.
//
// Este paquete es una HOJA del grafo de dependencias (3.3): no importa nada del
// proyecto.

export { consultaDeListado, listadoDe, LIMITE_DEFECTO, LIMITE_MAXIMO } from "./pagination.js";
export type { ConsultaDeListado } from "./pagination.js";

export { errorDeApi, ESTADO_POR_CODIGO } from "./error.js";
export type { CodigoDeError, ErrorDeApi } from "./error.js";

export {
  consultaDeAuditoria,
  idDeRegistro,
  listadoDeAuditoria,
  registroDeAuditoria,
  tipoDeActor,
  tipoDeEntidad,
  TIPOS_DE_ACTOR,
  TIPOS_DE_ENTIDAD,
} from "./audit.js";
export type {
  ConsultaDeAuditoria,
  ListadoDeAuditoria,
  RegistroDeAuditoria,
  TipoDeActor,
  TipoDeEntidad,
} from "./audit.js";

export {
  actualizarTablero,
  crearTablero,
  listadoDeTableros,
  parametrosDeTablero,
  tablero,
  tableroDetallado,
  LIMITE_DESCRIPCION_TABLERO,
  LIMITE_NOMBRE_TABLERO,
} from "./board.js";
export type {
  ActualizarTablero,
  CrearTablero,
  ListadoDeTableros,
  ParametrosDeTablero,
  Tablero,
  TableroDetallado,
} from "./board.js";

export {
  actualizarColumna,
  columna,
  columnaConOrden,
  columnaDetallada,
  consultaDeBorradoDeColumna,
  crearColumna,
  parametrosDeColumna,
  LIMITE_NOMBRE_COLUMNA,
} from "./column.js";
export type {
  ActualizarColumna,
  Columna,
  ColumnaConOrden,
  ColumnaDetallada,
  ConsultaDeBorradoDeColumna,
  CrearColumna,
  ParametrosDeColumna,
} from "./column.js";

export {
  actualizarTarea,
  coincidencia,
  consultaDeBusqueda,
  consultaDeTareas,
  crearTarea,
  fechaSola,
  listadoDeCoincidencias,
  listadoDeTareas,
  moverTarea,
  ordenDeColumna,
  ordenDeTarea,
  parametrosDeTarea,
  prioridad,
  resultadoDeMovimiento,
  tarea,
  LIMITE_TITULO_TAREA,
  ORDENES_DE_TAREA,
  PRIORIDADES,
} from "./task.js";
export type {
  ActualizarTarea,
  Coincidencia,
  ConsultaDeBusqueda,
  ConsultaDeTareas,
  CrearTarea,
  ListadoDeCoincidencias,
  ListadoDeTareas,
  MoverTarea,
  OrdenDeColumna,
  OrdenDeTarea,
  ParametrosDeTarea,
  Prioridad,
  ResultadoDeMovimiento,
  Tarea,
} from "./task.js";
