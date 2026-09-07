import { z } from "zod";

import { DomainError, isDomainError } from "../domain/errors.js";
import type { EsquemaEntrada, McpToolResult } from "./tool.js";

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

/** La envoltura de error de la 6.4, sin `request_id`: todavia no hay auditoria. */
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

  return {
    content: [{ type: "text", text: texto(lineas, { error }) }],
    isError: true,
  };
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
 * publica. Aca el transporte es stdio contra la maquina del propio usuario, y
 * todavia no hay log ni `request_id` con el que correlacionar, asi que la causa
 * va en `details.reason`: sin ella un fallo inesperado seria completamente
 * opaco. Cuando exista el transporte HTTP, ese borde tendra que recortarla.
 */
function deErrorInesperado(error: unknown, herramienta: string): ErrorSerializado {
  return {
    code: "INTERNAL_ERROR",
    message: `La herramienta ${herramienta} fallo de forma inesperada.`,
    details: { reason: error instanceof Error ? error.message : String(error) },
    hint: "No es un error de tus argumentos: reintentar tal cual probablemente vuelva a fallar.",
  };
}

/**
 * Envuelve el cuerpo de una herramienta: valida la entrada y traduce cualquier
 * fallo a una respuesta accionable.
 */
export function definirHandler<Shape extends EsquemaEntrada>(
  herramienta: string,
  shape: Shape,
  cuerpo: (args: z.output<z.ZodObject<Shape>>) => Promise<McpToolResult>,
): (args: unknown) => Promise<McpToolResult> {
  const esquema = z.object(shape);

  return async (args: unknown): Promise<McpToolResult> => {
    const validado = esquema.safeParse(args ?? {});
    if (!validado.success) {
      return respuestaError(deZodError(validado.error));
    }

    try {
      return await cuerpo(validado.data);
    } catch (error: unknown) {
      return respuestaError(
        isDomainError(error) ? serializarDominio(error) : deErrorInesperado(error, herramienta),
      );
    }
  };
}
