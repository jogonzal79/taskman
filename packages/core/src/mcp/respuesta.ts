import { z } from "zod";

import { DomainError, isDomainError } from "../domain/errors";
import type { EntornoMcp, Llamada } from "./llamada";
import type { EsquemaEntrada, McpToolResult } from "./tool";

/**
 * Formato de respuesta de la 8.5.
 *
 * Cada herramienta devuelve texto legible MAS un bloque JSON con el estado
 * final. No es redundancia: el texto es lo que el agente usa para redactarle al
 * usuario, y el JSON es lo que le permite encadenar la llamada siguiente sin
 * volver a consultar. Si faltara el texto, el agente parafrasearia JSON; si
 * faltara el JSON, tendria que reparsear prosa para sacar un id.
 *
 * El JSON va en snake_case, igual que la API REST de la 6.3: es el mismo
 * contrato visto desde otro transporte, y alternar estilos entre los dos
 * bordes solo sirve para confundir a quien los usa.
 */

/** Serializa el bloque de estado. Indentado: lo lee un modelo, no una maquina. */
function bloqueJson(estado: unknown): string {
  return ["```json", JSON.stringify(estado, null, 2), "```"].join("\n");
}

function texto(lineas: readonly string[], estado: unknown): string {
  return `${lineas.join("\n")}\n\n${bloqueJson(estado)}`;
}

export function respuesta(lineas: readonly string[], estado: unknown): McpToolResult {
  return { content: [{ type: "text", text: texto(lineas, estado) }] };
}

/** Fecha DATE de PostgreSQL a `AAAA-MM-DD`. Llega como medianoche UTC. */
export function fechaIso(fecha: Date | null): string | null {
  return fecha === null ? null : fecha.toISOString().slice(0, 10);
}

// --- Errores -----------------------------------------------------------------

/**
 * La envoltura de error de la 6.4, sin `request_id`.
 *
 * Desde la 11.1 el requestId existe en TODAS las invocaciones —lo arma el
 * ejecutor, no cada herramienta— asi que la razon vieja para no ponerlo aca
 * (que las lecturas no tenian contexto) ya no vale. Sigue afuera por otra: el
 * `request_id` en la respuesta es del modelo de errores REST de la 6.4, que
 * pide "la respuesta solo expone el codigo y el request_id" para NO exponer la
 * causa. Aca la causa se expone a proposito (ver `deErrorInesperado`), y
 * agregar el id sin ese recorte seria media 6.4. Entra con el borde HTTP.
 */
export interface ErrorSerializado {
  code: string;
  message: string;
  details?: unknown;
  hint?: string;
}

export function serializarDominio(error: DomainError): ErrorSerializado {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

/**
 * El codigo de un error que se DEVUELVE en vez de lanzarse.
 *
 * Existe por delete_task: la confirmacion de la 8.3.2 no es una excepcion, es
 * una respuesta —la herramienta ya leyo la tarea y la esta mostrando— asi que
 * vuelve por `return` y el ejecutor no la ve pasar por su `catch`. Sin esto,
 * un CONFIRMATION_REQUIRED se registraria como `outcome: "ok"`, que es
 * exactamente el caso que la 11.1 quiere poder diagnosticar.
 *
 * Es un Symbol y no un campo mas porque el resultado viaja al SDK tal cual:
 * `JSON.stringify` ignora las claves Symbol, asi que esto no puede filtrarse al
 * protocolo ni obliga a ningun adaptador a acordarse de recortarlo.
 */
const CODIGO_DE_ERROR = Symbol("taskman.codigoDeError");

interface ResultadoConCodigo extends McpToolResult {
  readonly [CODIGO_DE_ERROR]?: string;
}

export function codigoDeError(resultado: McpToolResult): string | undefined {
  return (resultado as ResultadoConCodigo)[CODIGO_DE_ERROR];
}

/**
 * Un error como respuesta MCP.
 *
 * `isError: true` en vez de una excepcion porque el agente TIENE que leerlo:
 * un AMBIGUOUS_MATCH no es un fallo del sistema, es una pregunta al llamador, y
 * el `hint` es la respuesta que se espera que ejecute.
 *
 * `lineasExtra` va entre el mensaje y el hint, que es el orden en que se lee:
 * que paso, sobre que, y que hacer. Existe para CONFIRMATION_REQUIRED (8.3.2),
 * donde el detalle de la tarea que se borraria tiene que estar en el TEXTO y no
 * solo en `details`: el texto es lo que el agente le muestra al usuario, y una
 * confirmacion que solo se puede leer parseando JSON no es una confirmacion.
 */
export function respuestaError(
  error: ErrorSerializado,
  lineasExtra: readonly string[] = [],
): McpToolResult {
  const lineas = [`Error ${error.code}: ${error.message}`, ...lineasExtra];
  if (error.hint !== undefined) {
    lineas.push(`Que hacer: ${error.hint}`);
  }

  const resultado: ResultadoConCodigo = {
    content: [{ type: "text", text: texto(lineas, { error }) }],
    isError: true,
    [CODIGO_DE_ERROR]: error.code,
  };
  return resultado;
}

/** Un fallo de validacion de Zod, con la lista de campos y el motivo (6.4). */
function deZodError(error: z.ZodError): ErrorSerializado {
  return {
    code: "VALIDATION_ERROR",
    message: "Los argumentos de la herramienta no son validos.",
    details: {
      fields: error.issues.map((issue) => ({
        field: issue.path.join(".") || "(raiz)",
        reason: issue.message,
      })),
    },
    hint: "Corregi los campos de details.fields y volve a llamar a la herramienta.",
  };
}

/**
 * Fallo no controlado (6.4).
 *
 * La 6.4 pide que el mensaje no exponga detalles internos, pensando en una API
 * publica. Aca el transporte es stdio contra la maquina del propio usuario, asi
 * que la causa va en `details.reason`: sin ella un fallo inesperado seria
 * completamente opaco para el agente, que es quien tiene que decidir si
 * reintenta. Cuando exista el transporte HTTP, ese borde tendra que recortarla
 * y dejar solo el codigo y el request_id.
 */
function deErrorInesperado(error: unknown, herramienta: string): ErrorSerializado {
  return {
    code: "INTERNAL_ERROR",
    message: `La herramienta ${herramienta} fallo de forma inesperada.`,
    details: { reason: error instanceof Error ? error.message : String(error) },
    hint: "No es un error de tus argumentos: reintentar tal cual probablemente vuelva a fallar.",
  };
}

/** Como termino una invocacion, en el vocabulario de la linea `mcp.tool`. */
type Desenlace = "ok" | "domain_error" | "error";

/**
 * El punto UNICO de ejecucion de herramientas: valida la entrada, arma el
 * contexto de la invocacion, traduce cualquier fallo a una respuesta
 * accionable y deja la linea `mcp.tool` de la 11.1.
 *
 * Que sea uno solo es lo que hace que la instrumentacion no se pueda olvidar:
 * las once herramientas de la 8.2 se declaran a traves de aca, asi que no hay
 * ninguna que pueda ejecutarse sin registrarse, y no hay una sola linea de log
 * dentro de las herramientas. Si manana se agrega la doce, ya esta instrumentada.
 *
 * El `ActorContext` se arma ACA, una vez por invocacion, y baja por `Llamada`
 * tanto a la escritura que audita como a la resolucion por nombre. Antes lo
 * armaba cada herramienta de escritura en el momento del write: alcanzaba para
 * la 7.4 pero no para la 11.1, porque la resolucion ocurre antes del write y
 * las lecturas no tenian contexto ninguno. Ahora el `request_id` de `audit_log`
 * y el `requestId` de las lineas de log son el mismo valor por construccion, no
 * por coincidencia.
 */
export function definirHandler<Shape extends EsquemaEntrada>(
  entorno: EntornoMcp,
  herramienta: string,
  shape: Shape,
  cuerpo: (args: z.output<z.ZodObject<Shape>>, llamada: Llamada) => Promise<McpToolResult>,
): (args: unknown) => Promise<McpToolResult> {
  const esquema = z.object(shape);

  return async (args: unknown): Promise<McpToolResult> => {
    const llamada: Llamada = { ctx: entorno.contexto(), logger: entorno.logger };
    const comienzo = performance.now();

    let salida: McpToolResult;
    let desenlace: Desenlace;
    let code: string | undefined;

    const validado = esquema.safeParse(args ?? {});
    if (!validado.success) {
      salida = respuestaError(deZodError(validado.error));
      desenlace = "domain_error";
      code = "VALIDATION_ERROR";
    } else {
      try {
        salida = await cuerpo(validado.data, llamada);
        // Una herramienta puede DEVOLVER un error en vez de lanzarlo: es lo que
        // hace delete_task con CONFIRMATION_REQUIRED. Sin mirar el resultado,
        // esa llamada quedaria registrada como exitosa.
        code = codigoDeError(salida);
        desenlace = code === undefined ? "ok" : "domain_error";
      } catch (error: unknown) {
        const dominio = isDomainError(error);
        salida = respuestaError(
          dominio ? serializarDominio(error) : deErrorInesperado(error, herramienta),
        );
        desenlace = dominio ? "domain_error" : "error";
        // Sin `code` cuando el fallo es inesperado: el INTERNAL_ERROR de la
        // respuesta es una etiqueta del borde, no un codigo de dominio, y
        // ponerlo aca lo haria indistinguible de uno que si lo es al filtrar.
        code = dominio ? error.code : undefined;
      }
    }

    const campos = {
      evt: "mcp.tool",
      tool: herramienta,
      requestId: llamada.ctx.requestId,
      actorType: llamada.ctx.actorType,
      actorName: llamada.ctx.actorName,
      durationMs: Math.round(performance.now() - comienzo),
      outcome: desenlace,
      ...(code === undefined ? {} : { code }),
    };
    const mensaje = `${herramienta}: ${desenlace}`;

    // Un error de dominio es trafico normal —un AMBIGUOUS_MATCH es una pregunta
    // al agente, no una falla— asi que va en info. `error` queda para lo que de
    // verdad no se esperaba, que es lo que se busca cuando algo anda mal.
    if (desenlace === "error") {
      llamada.logger.error(campos, mensaje);
    } else {
      llamada.logger.info(campos, mensaje);
    }

    return salida;
  };
}
