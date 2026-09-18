import { z, type ZodType } from "zod";

import type { Scope } from "../domain/api-key";

/**
 * La forma de una herramienta MCP, descrita como DATO.
 *
 * No importa el SDK de MCP a proposito: CLAUDE.md prohibe que `packages/core`
 * lo haga, y la 8.1 pide que el registro de herramientas sea uno solo,
 * compartido por los dos transportes. Las dos cosas se cumplen si el nucleo
 * declara herramientas como dato y las monta sobre un servidor que describe por
 * su FORMA (`montaje.ts`); cada app solo construye su `McpServer` y su
 * transporte.
 *
 * Los tipos de contenido replican la forma que espera el SDK (`{type:"text"}`),
 * que es parte del protocolo, no de la libreria.
 *
 * SON `type` Y NO `interface`, y no es estilo. El resultado que el SDK espera
 * declara una firma de indice (`[x: string]: unknown`), y en TypeScript solo un
 * alias de tipo se le asigna sin tenerla escrita: una interface no. Con
 * interface, el `McpServer` del SDK no encaja en `ServidorDeHerramientas` y el
 * montaje compartido necesitaria un cast (comprobado con tsc).
 */

export type McpTextContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpTextContent[];
  /** true cuando la llamada fallo. El agente lo ve como resultado, no como excepcion. */
  isError?: boolean;
};

/** Esquema de entrada: el "raw shape" de Zod con el que cada herramienta declara sus campos. */
export type EsquemaEntrada = Record<string, ZodType>;

/** El esquema CONSTRUIDO a partir de un `EsquemaEntrada`: lo que valida de verdad. */
export type EntradaDeHerramienta<Shape extends EsquemaEntrada = EsquemaEntrada> = z.ZodObject<
  Shape,
  z.core.$strict
>;

/**
 * EL UNICO lugar donde se decide que forma tiene la entrada de una herramienta:
 * un objeto ESTRICTO, que rechaza las claves que el esquema no declara.
 *
 * Lo usan los dos que validan, `definirHandler` y `montarHerramientas`, y tiene
 * que ser uno solo porque el SDK valida PRIMERO. `registerTool` recibe el
 * esquema, lo aplica antes de invocar el handler y le entrega al handler el
 * resultado del parse, no los argumentos originales. Con el "raw shape" el SDK lo
 * envolvia en su propio `z.object`, que no es estricto: un argumento que la
 * herramienta no declara se QUITABA ahi, en silencio, y al handler le llegaba la
 * llamada como si nunca lo hubiera traido. Un `strictObject` solo en
 * `definirHandler` no habria cambiado nada por stdio ni por /mcp.
 *
 * Que sea estricto es lo que el borde REST ya hace con los cuerpos y las
 * consultas (`strictObject` en `packages/contracts`, `leerConsulta` en
 * `apps/web`), y la asimetria importaba mas de lo que suena: en
 * `MCP_PORT_MODE=http` el argumento recortado ni siquiera llegaba a la query, asi
 * que la herramienta ACEPTABA lo que el endpoint, con esos mismos datos, habria
 * rechazado con 400. Y estos argumentos los arma un modelo: `status: "DONE"`
 * sobre list_tasks es exactamente el nombre que un modelo inventa, y un tablero
 * entero devuelto como si estuviera filtrado es peor que un error.
 *
 * Lo que el protocolo manda por su cuenta NO pasa por aca: `_meta`, `task` y el
 * resto viajan en `params`, al lado de `arguments`, no adentro. Y el cliente de
 * la SDK no agrega nada adentro de `arguments`: si lo hiciera, ninguna llamada
 * valida pasaria un esquema estricto, y las pasan en las tres suites que usan
 * ese cliente, por los dos transportes. Lo unico que un objeto estricto rechaza
 * es lo que el llamador escribio de mas.
 *
 * En el JSON Schema de tools/list esto sale como `additionalProperties: false`,
 * que es la misma regla dicha en el idioma del cliente.
 */
export function esquemaDeEntrada<Shape extends EsquemaEntrada>(
  shape: Shape,
): EntradaDeHerramienta<Shape> {
  return z.strictObject(shape);
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: EsquemaEntrada;
  /**
   * El scope de la 7.2 que exige la herramienta: la columna Scope de la 8.2
   * convertida en dato, en vez de vivir solo en el documento.
   *
   * OBLIGATORIO y sin valor por defecto, por lo mismo que el scope de `conAuth`
   * en el borde REST: una herramienta nueva que no lo declare no compila, asi que
   * la forma de dejar una abierta por descuido no existe. Falla cerrado.
   *
   * En el vocabulario del DOMINIO (`READ`, `WRITE`, `DELETE`) y no en el de la
   * 8.2, que lo escribe en minuscula como el borde HTTP. Es el mismo tipo que
   * `ClaveAutenticada.scopes`, asi que compararlos no necesita traduccion; la de
   * minuscula a mayuscula es del borde (`apps/web/lib/auth.ts`).
   *
   * No es un campo del protocolo y ningun transporte lo envia: con el,
   * `crearHerramientas` deja fuera las que la clave de quien llama no puede usar
   * (8.1). Tampoco depende de MCP_DESTRUCTIVE_POLICY: el scope dice que necesita
   * la clave, la politica dice que permite el servidor.
   */
  scope: Scope;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * Si la herramienta se ANUNCIA en el listado. Ausente es `true`.
   *
   * No es un campo del protocolo: es como el nucleo le dice al transporte que
   * una herramienta existe pero no se ofrece. Lo pide la 8.1 —"el filtrado
   * ocurre en el listado de herramientas, no solo en la ejecucion, para que el
   * agente no planifique acciones que no puede completar"— y lo usa
   * MCP_DESTRUCTIVE_POLICY=deny. Los scopes de la 7.2 NO lo usan: una herramienta
   * fuera de los scopes de la clave directamente no se devuelve, y que los dos
   * filtros no compartan este campo es lo que impide que uno deshaga al otro
   * (ver `crearHerramientas`).
   *
   * La definicion no se omite del registro: sigue existiendo, con su handler,
   * que responde por que no se puede. Omitirla dejaria al llamador con un
   * "herramienta desconocida", que no distingue una politica de un error.
   */
  anunciada?: boolean;
  /**
   * Recibe los argumentos SIN validar y los valida contra `inputSchema`, con el
   * mismo `esquemaDeEntrada` que el montaje le da al SDK.
   *
   * El SDK tambien valida antes de llamar, asi que en produccion la segunda
   * pasada no rechaza nada. Se hace igual para que la definicion sea
   * autocontenida: un `HttpPort` o una prueba pueden invocar el handler
   * directamente sin reimplementar la validacion ni la traduccion de errores.
   */
  handler(args: unknown): Promise<McpToolResult>;
}
