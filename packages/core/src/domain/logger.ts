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

/**
 * Los cuatro niveles de LOG_LEVEL (11.2). pino admite mas; el contrato son estos.
 *
 * El vocabulario y su validacion viven aca —y no en cada app— por lo mismo que
 * `leerPoliticaDestructiva` de `mcp/politica.ts`: es la forma de un valor de
 * configuracion, la misma para todos los bordes, y tenerla dos veces es tenerla
 * dos veces mal el dia que cambie. Lo que NO vive aca es leer `process.env`, que
 * es de cada app, ni ELEGIR EL DESTINO, que es de cada app y por buenos motivos:
 * en `apps/mcp-stdio` el fd 1 es el canal del protocolo MCP y el log tiene que ir
 * al fd 2, mientras en `apps/web` el fd 1 es exactamente donde va.
 *
 * Estaban en `apps/mcp-stdio/src/log.ts`, que fue el primer borde con log, y ese
 * modulo los reexporta para no cambiarle la superficie a nadie.
 */
export const NIVELES_LOG = ["debug", "info", "warn", "error"] as const;

export type NivelLog = (typeof NIVELES_LOG)[number];

/** La 11.2 fija `info`: sin configurar se registra la actividad, no el detalle. */
export const NIVEL_LOG_POR_DEFECTO: NivelLog = "info";

/**
 * Valida el valor crudo de LOG_LEVEL.
 *
 * Mismo criterio que `leerPoliticaDestructiva`: ausente o vacia es el valor por
 * defecto, cualquier otra cosa LANZA. La 11.2 lo pide en general, y aca tiene su
 * motivo propio: quien escribio `LOG_LEVEL=verbose` esta buscando un problema, y
 * arrancar en `info` le daria menos lineas de las que cree tener justo cuando
 * esta diagnosticando.
 */
export function leerNivelLog(valor: string | undefined): NivelLog {
  const bruto = (valor ?? "").trim().toLowerCase();
  if (bruto === "") {
    return NIVEL_LOG_POR_DEFECTO;
  }

  const nivel = NIVELES_LOG.find((candidato) => candidato === bruto);
  if (nivel === undefined) {
    throw new Error(
      `LOG_LEVEL="${valor ?? ""}" no es un valor valido. ` +
        `Los valores posibles son: ${NIVELES_LOG.join(", ")}. ` +
        `Sin definir equivale a "${NIVEL_LOG_POR_DEFECTO}".`,
    );
  }

  return nivel;
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
