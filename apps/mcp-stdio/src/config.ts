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

const MODOS = ["core"] as const;

export const MODO_POR_DEFECTO = "core";

const NODE_ENVS = ["development", "test", "production"] as const;

/** Ver la nota de `DATABASE_URL`: un solo mensaje para ausente y para vacia. */
function obligatoria(expectativa: string) {
  return z.string({ error: expectativa }).trim().min(1, { error: expectativa });
}

/**
 * MCP_PORT_MODE (8.1). Solo `core` esta implementado: `http` esta en la
 * especificacion pero `HttpPort` no existe todavia, y arrancar en un modo sin
 * implementacion daria un servidor que lista herramientas y falla en la primera
 * llamada, que es peor que no arrancar.
 *
 * Cuando exista, TASKMAN_API_URL y TASKMAN_API_KEY —las otras dos variables que
 * la 11.2 declara para este proceso— entran ACA, como campos obligatorios de la
 * rama `http` de una union discriminada por el modo. Hoy no se declaran porque
 * serian validacion de una rama inalcanzable, o sea codigo que nadie puede
 * ejercitar.
 */
export const esquemaDeEntorno = z.object({
  MCP_PORT_MODE: z
    .enum(MODOS, {
      error: `"${MODO_POR_DEFECTO}" (los servicios en proceso). El modo http de la 8.1 todavia no esta implementado`,
    })
    .optional()
    .transform((valor) => valor ?? MODO_POR_DEFECTO),

  /**
   * Obligatoria porque el unico modo que existe habla con la base en proceso.
   *
   * El mensaje es el MISMO para la ausente y para la vacia: Zod usaria el del tipo
   * en un caso y el del `min(1)` en el otro, y escribir dos deja al caso mas comun
   * —la ausente— con el menos util. Para la 11.2 son el mismo caso.
   */
  DATABASE_URL: obligatoria(
    "la cadena de conexion a PostgreSQL: definila en el bloque env del .mcp.json o en el entorno",
  ),

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
});

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

  const lineas = resultado.error.issues.map((issue) => {
    const nombre = String(issue.path[0] ?? "(sin nombre)");
    const valor = env[nombre];
    const vacia = valor === undefined || valor.trim() === "";

    return vacia
      ? `  - ${nombre}: falta; se esperaba ${issue.message}.`
      : `  - ${nombre}="${valor}": se esperaba ${issue.message}.`;
  });

  throw new Error(
    ["La configuracion del entorno no es valida (11.2):", ...lineas].join("\n"),
  );
}
