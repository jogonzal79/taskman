import {
  leerNivelLog,
  leerPoliticaDestructiva,
  NIVEL_LOG_POR_DEFECTO,
  NIVELES_LOG,
  POLITICAS_DESTRUCTIVAS,
  POLITICA_DESTRUCTIVA_POR_DEFECTO,
  type NivelLog,
  type PoliticaDestructiva,
} from "@taskman/core";
import { z } from "zod";

/**
 * El esquema de configuracion de la 11.2 para `apps/mcp-stdio`, validado al
 * arrancar.
 *
 * Antes habia cuatro comprobaciones sueltas en el entrypoint, cada una con su
 * `fallar()`: MCP_PORT_MODE contra un Set, DATABASE_URL no vacia, y
 * MCP_DESTRUCTIVE_POLICY y LOG_LEVEL con un try/catch cada una. Hacian lo
 * correcto —la 11.2 se cumplia— pero de a una: la primera que fallaba tapaba a
 * las demas, y agregar una variable era agregar un bloque mas.
 *
 * ES OTRO ESQUEMA que el de `apps/web`, no una parte del mismo: las variables no
 * coinciden y la forma de este depende del MODO, que es una union discriminada
 * que solo existe aca. Lo compartido es el vocabulario, que vive en el nucleo.
 *
 * No lee `process.env`: lo recibe. Aca no hay un bundler que lo exija, pero la
 * simetria con `apps/web` vale por si sola y de paso hace el esquema probable sin
 * tocar el entorno del proceso.
 */

const MODOS = ["core", "http"] as const;

export const MODO_POR_DEFECTO = "core";

const NODE_ENVS = ["development", "test", "production"] as const;

/** Ver la nota de `DATABASE_URL`: un solo mensaje para ausente y para vacia. */
function obligatoria(expectativa: string) {
  return z.string({ error: expectativa }).trim().min(1, { error: expectativa });
}

/**
 * Lo que NO depende del modo: se valida igual en las dos ramas.
 *
 * Va como objeto suelto y no como un esquema del que las ramas hereden porque
 * `z.discriminatedUnion` necesita dos `z.object` completos, y porque el mismo
 * objeto sirve ademas para validar lo comun CUANDO EL MODO NO SE ENTIENDE (ver
 * `validarEntorno`).
 */
const COMUN = {
  NODE_ENV: z.enum(NODE_ENVS, { error: `uno de: ${NODE_ENVS.join(", ")}` }).optional(),

  LOG_LEVEL: z
    .string()
    .optional()
    .transform((valor, ctx): NivelLog => {
      try {
        return leerNivelLog(valor);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `uno de: ${NIVELES_LOG.join(", ")} (ausente equivale a ${NIVEL_LOG_POR_DEFECTO})`,
        });

        return NIVEL_LOG_POR_DEFECTO;
      }
    }),

  /**
   * MCP_DESTRUCTIVE_POLICY (8.3.2, 11.2). Un valor mal escrito NO cae en el valor
   * por defecto: quien puso "denyy" cree tener el borrado apagado y lo tendria
   * encendido, solo que preguntando primero.
   */
  MCP_DESTRUCTIVE_POLICY: z
    .string()
    .optional()
    .transform((valor, ctx): PoliticaDestructiva => {
      try {
        return leerPoliticaDestructiva(valor);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: `uno de: ${POLITICAS_DESTRUCTIVAS.join(", ")} (ausente equivale a ${POLITICA_DESTRUCTIVA_POR_DEFECTO})`,
        });

        return POLITICA_DESTRUCTIVA_POR_DEFECTO;
      }
    }),
};

/**
 * Modo `core` (8.1): los servicios en el mismo proceso, contra PostgreSQL.
 *
 * DATABASE_URL es obligatoria ACA Y SOLO ACA, que es lo que dice la columna
 * "Ambito" de la 11.2 —"web, mcp-stdio (modo core)"— y que hasta este paso no se
 * podia escribir porque no habia otra rama.
 *
 * El mensaje es el MISMO para la ausente y para la vacia: Zod usaria el del tipo
 * en un caso y el del `min(1)` en el otro, y escribir dos deja al caso mas comun
 * —la ausente— con el menos util. Para la 11.2 son el mismo caso.
 */
const esquemaCore = z.object({
  ...COMUN,
  MCP_PORT_MODE: z.literal("core"),
  DATABASE_URL: obligatoria(
    "la cadena de conexion a PostgreSQL: definila en el bloque env del .mcp.json o en el entorno",
  ),
});

/**
 * Modo `http` (8.1): el `HttpPort`, contra la API REST con una API key.
 *
 * DATABASE_URL NO SE PIDE, y no es un olvido: en este modo el proceso no abre
 * ninguna conexion a la base —habla con `/api`, que es quien la tiene— asi que
 * exigirla seria pedir un dato que nadie lee. Lo peor de pedirla no es la
 * molestia: quien arranca contra un servidor remoto no tiene una cadena valida
 * que poner, asi que inventaria una, y una cadena inventada que nadie usa es
 * indistinguible de una equivocada que alguien si va a usar el dia que ese mismo
 * bloque `env` vuelva a modo core. Si esta definida se IGNORA —el esquema no es
 * estricto—, que es lo que pasa en una maquina de desarrollo donde el `.env` la
 * tiene para todo lo demas.
 *
 * TASKMAN_API_KEY se valida aca solo como NO VACIA. Que la clave SIRVA lo decide
 * el servidor, y lo comprueba el arranque con la sonda de
 * `HttpPort.descubrirScopes()`: un 401 ahi impide arrancar igual que una
 * variable ausente. La diferencia entre las dos validaciones no es de rigor sino
 * de QUIEN PUEDE VERLA —la forma la ve este proceso, el valor solo el servidor—
 * y por eso las dos terminan en lo mismo, que es lo que la 11.2 pide.
 */
const esquemaHttp = z.object({
  ...COMUN,
  MCP_PORT_MODE: z.literal("http"),
  TASKMAN_API_URL: obligatoria(
    "la URL base de la API: definila en el bloque env del .mcp.json o en el entorno",
  ).refine(esUrlDeApi, {
    error: "una URL absoluta http:// o https://, por ejemplo https://taskman.midominio.com",
  }),
  TASKMAN_API_KEY: obligatoria(
    "la API key de la 7.1 tal cual se emitio: definila en el bloque env del .mcp.json o en el entorno",
  ),
});

/**
 * Una URL que `HttpPort` pueda usar como raiz.
 *
 * Se comprueba el ESQUEMA ademas de que parsee: `new URL("mailto:x")` parsea, y
 * una TASKMAN_API_URL que no sea http(s) fallaria recien en el primer `fetch`,
 * que es exactamente el "fallo posterior en tiempo de ejecucion" que la 11.2
 * manda evitar. La barra final sobra o falta sin consecuencia: la recorta
 * `HttpPort`.
 */
function esUrlDeApi(valor: string): boolean {
  if (!URL.canParse(valor)) {
    return false;
  }

  const { protocol } = new URL(valor);

  return protocol === "http:" || protocol === "https:";
}

/**
 * MCP_PORT_MODE (8.1) decide QUE OTRAS VARIABLES hacen falta, asi que el esquema
 * es una union discriminada por el y no un objeto con campos opcionales.
 *
 * Lo que se gana es de TIPO y no de validacion: un objeto plano con
 * `TASKMAN_API_URL?: string` mas un `superRefine` valida exactamente lo mismo,
 * pero deja a quien construye el `HttpPort` con dos `string | undefined` que
 * tiene que volver a comprobar —o afirmar con un `!`— justo donde el esquema ya
 * lo sabia. Con la union, la rama que construye el puerto HTTP no compila sin
 * las dos variables, y la que construye el `CorePort` no puede leerlas por
 * error.
 *
 * EL DEFECTO DEL DISCRIMINANTE SE APLICA ANTES, en un `preprocess`, porque
 * `z.discriminatedUnion` necesita el literal presente para elegir la rama. De
 * paso queda alineado con las otras dos variables de vocabulario del nucleo
 * (`leerNivelLog`, `leerPoliticaDestructiva`): ausente o vacia es el valor por
 * defecto, y el valor se compara en minusculas. Antes `MCP_PORT_MODE=""` era un
 * error y `MCP_PORT_MODE=CORE` tambien; ahora son las dos `core`, como
 * `LOG_LEVEL=""` ya era `info`.
 */
export const esquemaDeEntorno = z.preprocess(
  conModoNormalizado,
  z.discriminatedUnion("MCP_PORT_MODE", [esquemaCore, esquemaHttp], {
    error: `uno de: ${MODOS.join(", ")} (ausente equivale a ${MODO_POR_DEFECTO})`,
  }),
);

function conModoNormalizado(valor: unknown): unknown {
  if (typeof valor !== "object" || valor === null) {
    return valor;
  }

  const env = valor as Record<string, unknown>;
  const crudo = typeof env["MCP_PORT_MODE"] === "string" ? env["MCP_PORT_MODE"].trim() : "";

  return { ...env, MCP_PORT_MODE: crudo === "" ? MODO_POR_DEFECTO : crudo.toLowerCase() };
}

export type Entorno = z.infer<typeof esquemaDeEntorno>;

export type EntornoCrudo = Readonly<Record<string, string | undefined>>;

/**
 * Valida el entorno y devuelve la configuracion, o LANZA con el listado COMPLETO
 * de lo que falta: quien arranca sin `.mcp.json` se entera de todo en el primer
 * intento y no de a una variable por reinicio, que es lo que pasaba con los
 * cuatro bloques sueltos.
 */
export function validarEntorno(env: EntornoCrudo): Entorno {
  const resultado = esquemaDeEntorno.safeParse(env);

  if (resultado.success) {
    return resultado.data;
  }

  const issues = [...resultado.error.issues];

  /**
   * UN MODO ILEGIBLE TAPA A TODO LO DEMAS, y hay que destaparlo a mano: cuando
   * el discriminante no coincide con ninguna rama, `z.discriminatedUnion` no
   * sabe cual validar y devuelve ese unico issue. Sin esto, un
   * `MCP_PORT_MODE=htpp` junto a un `LOG_LEVEL=verbose` costaria dos arranques,
   * que es justo lo que este esquema vino a terminar.
   *
   * Solo se recupera lo COMUN a los dos modos: cuales de las otras hacen falta es
   * lo que el modo decide, asi que no se elige una rama por el.
   */
  if (issues.every((issue) => issue.path[0] === "MCP_PORT_MODE")) {
    const comunes = z.object(COMUN).safeParse(env);

    if (!comunes.success) {
      issues.push(...comunes.error.issues);
    }
  }

  const lineas = issues.map((issue) => {
    const nombre = String(issue.path[0] ?? "(sin nombre)");
    const valor = env[nombre];
    const vacia = valor === undefined || valor.trim() === "";

    return vacia
      ? `  - ${nombre}: falta; se esperaba ${issue.message}.`
      : `  - ${nombre}="${valor}": se esperaba ${issue.message}.`;
  });

  throw new Error(["La configuracion del entorno no es valida (11.2):", ...lineas].join("\n"));
}
