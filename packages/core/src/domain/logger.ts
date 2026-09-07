/**
 * El log estructurado de la 11.1, visto desde el nucleo.
 *
 * Es una INTERFAZ y nada mas: `packages/core` no importa pino ni escribe a
 * stdout ni a stderr. La regla de dependencias de la 3.2 no menciona el log,
 * pero vale igual —un nucleo que eligiera su transporte de log no se podria
 * ejercitar sin el— y ademas hay una razon propia de este proyecto: stdout es
 * el canal del protocolo MCP, asi que quien decide DONDE se escribe tiene que
 * ser la app, que es la unica que sabe por que transporte esta hablando.
 *
 * La forma `(campos, mensaje)` es la de pino a proposito. No es atarse a la
 * libreria: es la forma que hace que los campos sean estructurados y el mensaje
 * sea decoracion, y no al reves. Un `log(\`herramienta ${nombre} en ${ms}ms\`)`
 * se lee igual de bien y no se puede filtrar por herramienta.
 *
 * Vive en `domain/` por la misma razon que `ActorContext`: es un contrato
 * transversal, sin dependencias, que los adaptadores llenan. Cuando exista la
 * API REST va a usar esta misma interfaz para la linea por peticion de la 11.1.
 */

/** Los campos estructurados de una linea. Se serializan a JSON tal cual. */
export interface CamposDeLog {
  readonly [clave: string]: unknown;
}

export interface Logger {
  debug(campos: CamposDeLog, mensaje: string): void;
  info(campos: CamposDeLog, mensaje: string): void;
  warn(campos: CamposDeLog, mensaje: string): void;
  error(campos: CamposDeLog, mensaje: string): void;
}

/**
 * El logger por defecto: no escribe nada.
 *
 * Existe para que instrumentar no obligue a inyectar. Las pruebas que ya habia
 * —y cualquier montaje del registro que no configure log— siguen corriendo sin
 * tocar una linea, y el que quiere diagnostico pasa el suyo.
 *
 * NO es un logger "apagado" que se pueda encender: apagar por nivel es del
 * logger real. Este es el hueco.
 */
export const LOGGER_NULO: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
