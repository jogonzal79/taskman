import { z } from "zod";

import { listadoDeAuditoria, registroDeAuditoria } from "../audit";
import {
  actualizarTablero,
  crearTablero,
  listadoDeTableros,
  tablero,
  tableroDetallado,
} from "../board";
import {
  actualizarColumna,
  columna,
  columnaConOrden,
  columnaDetallada,
  crearColumna,
} from "../column";
import { errorDeApi } from "../error";
import { salud, saludDegradada } from "../health";
import {
  actualizarTarea,
  coincidencia,
  crearTarea,
  listadoDeCoincidencias,
  listadoDeTareas,
  moverTarea,
  ordenDeColumna,
  resultadoDeMovimiento,
  tarea,
} from "../task";
import { esObjeto, type ObjetoJson, type ValorJson } from "./json";

/**
 * Los esquemas que viajan a `components.schemas` del documento, con el nombre
 * con el que se publican.
 *
 * El nombre publicado es el del export, en PascalCase: renombrar un esquema
 * aparece en el diff de openapi.json, que es de lo que se trata (ADR-006).
 *
 * Un esquema registrado aca y usado dentro de otro registrado sale como `$ref`
 * —`ListadoDeTareas.items` apunta a `Tarea`— y eso lo resuelve la conversion
 * por registro, no un recorrido nuestro. Los que se construyen con spread de
 * otro (`Coincidencia` sobre `tarea.shape`) son objetos DISTINTOS para Zod y
 * salen desarrollados: es fiel, es lo que declara el esquema.
 */
export const COMPONENTES = {
  Tablero: tablero,
  TableroDetallado: tableroDetallado,
  ListadoDeTableros: listadoDeTableros,
  CrearTablero: crearTablero,
  ActualizarTablero: actualizarTablero,
  Columna: columna,
  ColumnaDetallada: columnaDetallada,
  ColumnaConOrden: columnaConOrden,
  CrearColumna: crearColumna,
  ActualizarColumna: actualizarColumna,
  Tarea: tarea,
  ListadoDeTareas: listadoDeTareas,
  Coincidencia: coincidencia,
  ListadoDeCoincidencias: listadoDeCoincidencias,
  CrearTarea: crearTarea,
  ActualizarTarea: actualizarTarea,
  MoverTarea: moverTarea,
  OrdenDeColumna: ordenDeColumna,
  ResultadoDeMovimiento: resultadoDeMovimiento,
  RegistroDeAuditoria: registroDeAuditoria,
  ListadoDeAuditoria: listadoDeAuditoria,
  ErrorDeApi: errorDeApi,
  Salud: salud,
  SaludDegradada: saludDegradada,
} as const;

export type ComponenteId = keyof typeof COMPONENTES;

/**
 * Los componentes que se usan como CUERPO de peticion. Se listan aparte para
 * comprobarlos tambien en modo `input` (ver `componentesDeEsquema`).
 */
const CUERPOS = [
  "CrearTablero",
  "ActualizarTablero",
  "CrearColumna",
  "ActualizarColumna",
  "CrearTarea",
  "ActualizarTarea",
  "MoverTarea",
] as const satisfies readonly ComponenteId[];

/**
 * OpenAPI 3.1 usa JSON Schema draft 2020-12 tal cual, asi que la conversion no
 * necesita el dialecto recortado de `target: "openapi-3.0"`: el tipo nullable
 * como lista y `const` salen como los escribe Zod.
 */
const DESTINO = "draft-2020-12";

export const RAIZ_DE_ESQUEMAS = "#/components/schemas";

/**
 * `z.toJSONSchema` pone `$schema` en cada esquema y `$id` en los que salen de un
 * registro. Dentro de `components.schemas` los dos son ruido: el dialecto ya lo
 * declara el documento por ser 3.1, y el `$id` duplica la clave del mapa.
 */
function limpiar(esquema: ObjetoJson): ObjetoJson {
  const { $schema: _dialecto, $id: _id, ...resto } = esquema;
  return resto;
}

/**
 * Convierte un esquema suelto. `io` importa y no es un detalle: los esquemas de
 * consulta llevan `coerce`, `default` y `transform`, y en modo `output` Zod
 * rechaza el transform ("Transforms cannot be represented in JSON Schema"). Lo
 * que documenta un parametro es lo que ENTRA.
 */
export function aJsonSchema(esquema: z.ZodType, io: "input" | "output"): ObjetoJson {
  // El tipo que devuelve Zod es la misma forma vista como esquema; aca solo
  // interesa recorrerla como JSON.
  return limpiar(z.toJSONSchema(esquema, { target: DESTINO, io }) as unknown as ObjetoJson);
}

/**
 * `components.schemas` del documento.
 *
 * Se convierte en modo `output` porque la mayoria de los componentes son
 * respuestas. Los cuerpos de peticion se vuelven a convertir en modo `input` y
 * se COMPARAN: hoy los dos modos dan lo mismo en los siete —ninguno tiene
 * `default`, `coerce` ni `transform`— y mientras eso valga un solo componente
 * puede describir las dos direcciones. El dia que deje de valer, esta
 * comprobacion rompe la compilacion en vez de publicar en silencio la forma de
 * salida como si fuera la de entrada; el arreglo entonces es publicar dos
 * componentes, no relajar la comparacion.
 */
export function componentesDeEsquema(): Record<string, ObjetoJson> {
  const registro = z.registry<{ id: string }>();

  for (const [id, esquema] of Object.entries(COMPONENTES)) {
    registro.add(esquema, { id });
  }

  const convertidos = z.toJSONSchema(registro, {
    target: DESTINO,
    io: "output",
    uri: (id) => `${RAIZ_DE_ESQUEMAS}/${id}`,
  }).schemas;

  const salida: Record<string, ObjetoJson> = {};

  for (const id of Object.keys(COMPONENTES)) {
    const convertido = convertidos[id];

    if (convertido === undefined) {
      throw new Error(`El registro no devolvio el componente ${id}.`);
    }

    salida[id] = limpiar(convertido as unknown as ObjetoJson);
  }

  for (const id of CUERPOS) {
    if (JSON.stringify(aJsonSchema(COMPONENTES[id], "input")) !== JSON.stringify(salida[id])) {
      throw new Error(
        `El componente ${id} ya no convierte igual en modo input que en modo output, ` +
          "asi que un solo esquema no puede describir la peticion y la respuesta. " +
          "Publicalo como dos componentes.",
      );
    }
  }

  return salida;
}

/** Una referencia a un componente, para el cuerpo o para una respuesta. */
export function ref(id: ComponenteId): ObjetoJson {
  return { $ref: `${RAIZ_DE_ESQUEMAS}/${id}` };
}

export interface Parametro extends ObjetoJson {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: ValorJson;
}

/**
 * Un parametro por propiedad del esquema: los de consulta y los de ruta salen de
 * los MISMOS esquemas con los que el handler valida, con su tipo, su tope y su
 * valor por defecto.
 *
 * `explode` no se elige, se deduce: si la propiedad es un array, el parametro es
 * repetible (`?priority=HIGH&priority=URGENT`, la 6.3.2), y eso en OpenAPI es
 * `style: form` con `explode: true`.
 *
 * LO QUE SE PIERDE: los `.refine()` del esquema. Zod los descarta al convertir,
 * sin avisar, porque JSON Schema no puede expresarlos. En los esquemas de
 * consulta eso significa que las reglas ENTRE campos no llegan al documento
 * —"indica board_id o column_id" en GET /api/tasks, "entity_type junto a
 * entity_id" en la auditoria—, y en los cuerpos, que los topes de longitud
 * medidos en puntos de codigo tampoco. Falta antes que mentir: escribir a mano
 * lo que el esquema no puede dar es el desfase que la ADR-006 previene.
 */
export function parametrosDe(esquema: z.ZodType, sitio: "path" | "query"): readonly Parametro[] {
  const convertido = aJsonSchema(esquema, "input");
  const propiedades = convertido["properties"];
  const requeridos = convertido["required"];

  if (!esObjeto(propiedades)) {
    throw new Error(`El esquema de parametros ${sitio} no convirtio a un objeto con propiedades.`);
  }

  const obligatorios = new Set(
    Array.isArray(requeridos) ? requeridos.filter((nombre) => typeof nombre === "string") : [],
  );

  return Object.entries(propiedades).map(([nombre, subesquema]) => {
    const repetible = esObjeto(subesquema) && subesquema["type"] === "array";

    return {
      name: nombre,
      in: sitio,
      // Un parametro de ruta es obligatorio siempre, lo diga el esquema o no.
      required: sitio === "path" ? true : obligatorios.has(nombre),
      ...(repetible ? { style: "form", explode: true } : {}),
      schema: subesquema,
    };
  });
}
