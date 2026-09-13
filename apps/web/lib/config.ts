// Del SUBCAMINO y no del barrel, y no es cosmetico: este modulo lo importa
// `instrumentation.ts`, que Next compila TAMBIEN para el runtime edge. El barrel
// reexporta los repositorios, o sea `@taskman/db` -> `@prisma/adapter-pg` -> `pg`
// -> `fs`, y en edge no hay `fs`: el modulo no compila y TODA peticion de `next
// dev` responde 500. `next build` no lo ve —sin rutas edge no emite ese bundle— y
// `verify` tampoco lo veia, porque nada levantaba `next dev`.
//
// De los cuatro simbolos, tres son valores y uno es tipo, asi que `import type`
// no alcanza: `leerNivelLog`, `NIVELES_LOG` y `NIVEL_LOG_POR_DEFECTO` se ejecutan
// en el transform del esquema y sobreviven al borrado de tipos.
//
// `domain/logger.ts` es hoja —no importa nada, ni del nucleo ni de fuera— y por
// eso el subcamino es seguro: pedirlo no arrastra grafo. Si algun dia deja de ser
// hoja, esto vuelve a romperse igual de silenciosamente.
import { leerNivelLog, NIVEL_LOG_POR_DEFECTO, NIVELES_LOG, type NivelLog } from "@taskman/core/logger";
import { z } from "zod";

/**
 * El esquema de configuracion de la 11.2 para `apps/web`, validado AL ARRANCAR.
 *
 * "Una variable ausente o invalida DEBE impedir el arranque del proceso con un
 * mensaje explicito, no producir un fallo posterior en tiempo de ejecucion",
 * dice la 11.2. Antes habia tres comprobaciones sueltas en `instrumentation.ts`
 * —DATABASE_URL, RATE_LIMIT_ENABLED y LOG_LEVEL— y API_KEY_PEPPER no estaba en
 * ninguna: se validaba recien al construir el `ApiKeyService` de la primera
 * peticion autenticada, o sea el fallo posterior que la 11.2 prohibe con esas
 * palabras.
 *
 * UN ESQUEMA POR PROCESO, y no uno compartido con partes: las variables de la
 * tabla NO son las mismas. API_KEY_PEPPER y RATE_LIMIT_ENABLED son de web;
 * MCP_PORT_MODE, MCP_DESTRUCTIVE_POLICY y las dos TASKMAN_* son de mcp-stdio, y
 * ahi la forma depende del modo —en `http` hacen falta la URL y la clave, en
 * `core` la base— o sea una union discriminada que solo tiene sentido en ese
 * proceso. Un esquema unico tendria que declarar API_KEY_PEPPER opcional para que
 * mcp-stdio pase, y entonces no validaria lo unico que este paso vino a validar.
 * Lo que SI se comparte es el VOCABULARIO, que ya vive en el nucleo
 * (`leerNivelLog`, `leerPoliticaDestructiva`) y lo usan los dos.
 *
 * NO LEE `process.env`, y eso es la mitad del punto: recibe el entorno como
 * argumento. Leerlo al evaluar el modulo es la trampa que este repo ya pago dos
 * veces —el pepper del `ApiKeyService` y el logger perezoso— porque el
 * "Collecting page data" de `next build` IMPORTA cada modulo sin ejecutar nada, y
 * una lectura que lanza rompe el build. Validar al arrancar y validar al importar
 * no son lo mismo: lo primero pasa en `register()`, lo segundo no debe pasar.
 */

/** Lo que la 11.2 llama "ausente": no definida, o definida en blanco. */
function ausente(valor: string | undefined): boolean {
  return valor === undefined || valor.trim() === "";
}

/**
 * RATE_LIMIT_ENABLED (7.3, 11.2). LA UNICA definicion de la regla: solo el texto
 * "false" apaga el limite.
 *
 * Vive aca y la importa `lib/rate-limit.ts`, en vez de que cada uno la escriba:
 * si el esquema aceptara un vocabulario y el limite interpretara otro, un valor
 * podria pasar el arranque y significar lo contrario en la peticion. Falla
 * cerrado: ausente deja el limite ENCENDIDO.
 */
export function limiteHabilitado(valor: string | undefined): boolean {
  return valor?.trim().toLowerCase() !== "false";
}

const NODE_ENVS = ["development", "test", "production"] as const;

/**
 * Una variable obligatoria, con LA MISMA expectativa para los dos casos en que
 * puede fallar.
 *
 * Zod usa el mensaje del tipo cuando la clave falta y el del `min(1)` cuando esta
 * en blanco, asi que escribir dos mensajes distintos deja al caso mas comun —la
 * variable ausente— con el menos util de los dos. Y para la 11.2 son el mismo
 * caso: "ausente o invalida".
 */
function obligatoria(expectativa: string) {
  return z.string({ error: expectativa }).trim().min(1, { error: expectativa });
}

/**
 * El esquema. Cada campo lleva su propio mensaje, con la variable nombrada y lo
 * que se esperaba: un "configuracion invalida" a secas manda a leer el esquema,
 * que es justo lo que nadie quiere hacer cuando un servicio no arranca.
 *
 * OBLIGATORIAS: DATABASE_URL y API_KEY_PEPPER. Sin base no hay nada que servir, y
 * sin pepper las claves se hashearian sin secreto.
 *
 * CON VALOR POR DEFECTO: LOG_LEVEL (info, 11.2), RATE_LIMIT_ENABLED (encendido) y
 * NODE_ENV (lo fija Next; si viene, tiene que ser uno de los tres).
 */
export const esquemaDeEntorno = z.object({
  DATABASE_URL: obligatoria("la cadena de conexion a PostgreSQL"),

  API_KEY_PEPPER: obligatoria(
    "el secreto de servidor para el hash de las API keys (7.1); generalo con " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  ),

  NODE_ENV: z
    .enum(NODE_ENVS, { error: `uno de: ${NODE_ENVS.join(", ")}` })
    .optional(),

  // El vocabulario y su validacion son los del nucleo: un solo sitio para los
  // cuatro niveles, compartido con apps/mcp-stdio.
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

  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"], { error: 'exactamente "true" o "false" (ausente deja el limite encendido)' })
    .optional()
    .transform((valor) => limiteHabilitado(valor)),
});

export type Entorno = z.infer<typeof esquemaDeEntorno>;

/** Como se ve un entorno desde Node, sin depender de los tipos de Node. */
export type EntornoCrudo = Readonly<Record<string, string | undefined>>;

/**
 * Valida el entorno y devuelve la configuracion, o LANZA con el listado completo.
 *
 * Completo a proposito: Zod junta todos los problemas, asi que quien arranca sin
 * `.env` se entera de las dos variables que le faltan en el primer intento y no
 * de a una por reinicio.
 */
export function validarEntorno(env: EntornoCrudo): Entorno {
  const resultado = esquemaDeEntorno.safeParse(env);

  if (resultado.success) {
    return resultado.data;
  }

  const lineas = resultado.error.issues.map((issue) => {
    const nombre = String(issue.path[0] ?? "(sin nombre)");
    const valor = env[nombre];

    return ausente(valor)
      ? `  - ${nombre}: falta; se esperaba ${issue.message}.`
      : `  - ${nombre}="${valor}": se esperaba ${issue.message}.`;
  });

  throw new Error(
    [
      "La configuracion del entorno no es valida (11.2):",
      ...lineas,
      "Copia .env.example a .env en la raiz del repo y completalo.",
    ].join("\n"),
  );
}
