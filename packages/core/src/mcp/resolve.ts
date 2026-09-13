import type { DomainErrorCode } from "../domain/errors";
import { DomainError } from "../domain/errors";
import type { Llamada } from "./llamada";

/**
 * Resolucion por nombre (8.3.1). UN solo modulo para las tres entidades:
 * tablero, columna y tarea. La regla es la misma para todas, y tenerla escrita
 * tres veces seria la forma mas facil de que se separen.
 *
 * La regla, literal:
 *   - UUID valido: se usa directamente, sin buscar.
 *   - Texto: coincidencia exacta sin distinguir mayusculas dentro del ambito.
 *   - Exactamente una: se procede.
 *   - Cero: se reintenta con coincidencia parcial. Si sigue vacio, NOT_FOUND
 *     con hasta cinco candidatos proximos para que el agente reformule.
 *   - Mas de una: AMBIGUOUS_MATCH con TODOS los candidatos, sus ids y su
 *     columna. La herramienta NO elige por el usuario.
 */

/**
 * Deliberadamente laxo con la version y la variante: si tiene forma de UUID,
 * quien lo escribio lo escribio como identificador. Validar la version v4
 * rechazaria ids legitimos de otro origen y los mandaria a buscarse por nombre,
 * que es un fallo mucho mas confuso de leer.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: string): boolean {
  return UUID.test(valor.trim());
}

/** Cuantos titulos proximos acompanan a un NOT_FOUND (8.3.1). */
export const MAXIMO_SUGERENCIAS = 5;

export interface Candidato {
  id: string;
  /** Lo que un humano escribiria: el titulo de la tarea, el nombre del tablero. */
  label: string;
  /**
   * Formas alternativas que tambien cuentan como coincidencia exacta. Es lo que
   * permite que una columna se resuelva por su key (`TODO`) ademas de por su
   * nombre ("Por hacer").
   */
  alias?: readonly string[];
  /** Acompana al id en `details.candidates` de un AMBIGUOUS_MATCH. */
  extra?: Readonly<Record<string, unknown>>;
}

/** Las tres entidades que se resuelven por nombre (8.3.1). */
export type EntidadResuelta = "board" | "column" | "task";

/**
 * Como se llego al candidato. Es el campo mas util de la linea `mcp.resolve`:
 * dice si el agente esta trabajando con ids o adivinando nombres, que es la
 * diferencia entre un cliente que encadena bien y uno que va a tropezar.
 */
export type EstrategiaResolucion = "uuid" | "exact" | "partial";

export interface AmbitoResolucion {
  /** "tarea", "tablero", "columna": aparece en los mensajes de error. */
  entidad: string;
  /**
   * La misma entidad en el vocabulario del log (11.1), que es ingles y estable.
   * Va como DATO del ambito y no como una traduccion de `entidad` dentro del
   * modulo: la regla de resolucion es una sola y no puede empezar a tener un
   * `if` por entidad, ni siquiera para nombrarla.
   */
  entity: EntidadResuelta;
  /** El plural del anterior. Castellano: no siempre es agregar una "s". */
  plural: string;
  /**
   * Genero gramatical de `entidad`. Existe para que los mensajes se lean como
   * castellano: "ningun tablero" y "ninguna tarea", no "ninguna tablero". Un
   * error que se lee mal es un error que el agente cita mal al usuario.
   */
  genero: "m" | "f";
  /** Nombre del campo de entrada que trajo la referencia: `task`, `board`. */
  campo: string;
  /** Como se llama la etiqueta en los payloads: `title` para tareas, `name` si no. */
  etiqueta: string;
  /** Codigo de NOT_FOUND propio de la entidad. */
  notFound: DomainErrorCode;
  /** Donde se busco. Se copia en `details` para que el agente lo vea. */
  scope?: Readonly<Record<string, unknown>>;
}

/**
 * Recorta, colapsa los blancos internos y pasa a minusculas.
 *
 * La 8.3.1 solo pide ignorar mayusculas; lo de los blancos se agrega porque un
 * agente que copia un titulo de su propio texto trae dobles espacios con una
 * frecuencia incomoda, y "Revisar  HU-25" y "Revisar HU-25" son el mismo
 * titulo para cualquiera que los lea. Los acentos SI distinguen: quitarlos
 * fusionaria titulos que en castellano son distintos de verdad.
 */
function normalizar(valor: string): string {
  return valor.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Distancia de edicion, dos filas. Solo ordena sugerencias: no decide nada. */
function distancia(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const actual = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(
        (actual[j - 1] ?? 0) + 1,
        (anterior[j] ?? 0) + 1,
        (anterior[j - 1] ?? 0) + costo,
      );
    }
    anterior = actual;
  }

  return anterior[b.length] ?? Math.max(a.length, b.length);
}

const del = (ambito: AmbitoResolucion): string => (ambito.genero === "m" ? "del" : "de la");
const ningun = (ambito: AmbitoResolucion): string =>
  ambito.genero === "m" ? "ningun" : "ninguna";
const deseado = (ambito: AmbitoResolucion): string =>
  ambito.genero === "m" ? "deseado" : "deseada";
const crearlo = (ambito: AmbitoResolucion): string =>
  ambito.genero === "m" ? "crearlo" : "crearla";

function payload(candidato: Candidato, ambito: AmbitoResolucion): Record<string, unknown> {
  return { id: candidato.id, [ambito.etiqueta]: candidato.label, ...candidato.extra };
}

function ambiguo(
  referencia: string,
  coincidencias: readonly Candidato[],
  ambito: AmbitoResolucion,
): DomainError {
  return new DomainError(
    "AMBIGUOUS_MATCH",
    `Hay ${coincidencias.length} ${ambito.plural} que coinciden con "${referencia.trim()}".`,
    {
      details: {
        [ambito.campo]: referencia,
        ...ambito.scope,
        candidates: coincidencias.map((candidato) => payload(candidato, ambito)),
      },
      // El hint es la parte accionable: dice QUE hacer, no solo que fallo.
      hint: `Reintenta indicando el id exacto ${del(ambito)} ${ambito.entidad} ${deseado(ambito)}, tomandolo de details.candidates.`,
    },
  );
}

function noEncontrada(
  referencia: string,
  candidatos: readonly Candidato[],
  ambito: AmbitoResolucion,
): DomainError {
  const aguja = normalizar(referencia);
  const proximos = [...candidatos]
    .sort((a, b) => distancia(normalizar(a.label), aguja) - distancia(normalizar(b.label), aguja))
    .slice(0, MAXIMO_SUGERENCIAS)
    .map((candidato) => payload(candidato, ambito));

  return new DomainError(
    ambito.notFound,
    `No hay ${ningun(ambito)} ${ambito.entidad} que coincida con "${referencia.trim()}".`,
    {
      details: { [ambito.campo]: referencia, ...ambito.scope, suggestions: proximos },
      hint:
        proximos.length === 0
          ? `Ese ambito no contiene ${ningun(ambito)} ${ambito.entidad}: hay que ${crearlo(ambito)} antes de operar.`
          : `Reintenta con uno de los valores de details.suggestions, o con el id ${del(ambito)} ${ambito.entidad}.`,
    },
  );
}

/**
 * La linea `mcp.resolve` de la 11.1: como se resolvio una referencia.
 *
 * Se emite SIEMPRE, salga bien o mal, porque el caso que hay que diagnosticar
 * es justamente el que falla: un AMBIGUOUS_MATCH con `matches: 3` dice que el
 * agente eligio un nombre que empata con tres tareas, y eso no se deduce de la
 * respuesta que ve el usuario.
 *
 * `resolvedId` solo cuando hubo exactamente una coincidencia: con cero o con
 * varias no hay id resuelto, y poner el primero seria escribir en el log
 * justamente la eleccion que la 8.3.1 prohibe hacer.
 *
 * La referencia CRUDA —que para una tarea es su titulo— va aparte, en `debug`.
 * En `info` no entra: el nivel por defecto no tiene por que llevarse el
 * contenido de las tareas a un archivo de log. Con LOG_LEVEL=debug si, porque
 * ahi es donde hace falta reconstruir que escribio el agente.
 */
function registrarResolucion(
  llamada: Llamada,
  ambito: AmbitoResolucion,
  referencia: string,
  strategy: EstrategiaResolucion,
  coincidencias: readonly Candidato[],
): void {
  const unica = coincidencias.length === 1 ? coincidencias[0] : undefined;

  llamada.logger.info(
    {
      evt: "mcp.resolve",
      requestId: llamada.ctx.requestId,
      entity: ambito.entity,
      strategy,
      matches: coincidencias.length,
      ...(unica === undefined ? {} : { resolvedId: unica.id }),
    },
    `resolucion de ${ambito.entity} por ${strategy}: ${coincidencias.length}`,
  );

  llamada.logger.debug(
    {
      evt: "mcp.resolve.ref",
      requestId: llamada.ctx.requestId,
      entity: ambito.entity,
      field: ambito.campo,
      reference: referencia,
    },
    `referencia de ${ambito.entity}`,
  );
}

/**
 * Devuelve el candidato que corresponde a la referencia, o lanza el
 * `DomainError` que el agente necesita para corregirse.
 *
 * Un UUID no se busca contra la lista: se devuelve un candidato sintetico con
 * ese id. Es lo que dice la 8.3.1 ("se usa directamente") y ademas es lo que
 * hace que resolver por id no dependa de haber enumerado el ambito entero.
 *
 * `llamada` es obligatoria y no opcional a proposito. Este es el UNICO punto
 * por el que pasa una resolucion, asi que es el unico lugar donde el log puede
 * estar completo; un parametro opcional convertiria "esta resolucion no se
 * registro" en algo que se olvida en una llamada y no se nota nunca.
 *
 * El unico camino que NO deja linea es la referencia vacia: ahi no hubo
 * resolucion que registrar, y anotarla como "exact con 0 coincidencias" seria
 * inventar una busqueda que nunca se hizo. Ese caso se ve igual, en la linea
 * `mcp.tool` de la invocacion, como VALIDATION_ERROR.
 */
export function resolverReferencia(
  referencia: string,
  candidatos: readonly Candidato[],
  ambito: AmbitoResolucion,
  llamada: Llamada,
): Candidato {
  if (esUuid(referencia)) {
    const sintetico: Candidato = { id: referencia.trim(), label: referencia.trim() };
    registrarResolucion(llamada, ambito, referencia, "uuid", [sintetico]);
    return sintetico;
  }

  const aguja = normalizar(referencia);
  if (aguja === "") {
    throw new DomainError("VALIDATION_ERROR", `El campo ${ambito.campo} esta vacio.`, {
      details: { field: ambito.campo, ...ambito.scope },
      hint: `Indica el id o el nombre ${del(ambito)} ${ambito.entidad}.`,
    });
  }

  const exactas = candidatos.filter(
    (candidato) =>
      normalizar(candidato.label) === aguja ||
      (candidato.alias ?? []).some((alias) => normalizar(alias) === aguja),
  );
  if (exactas.length !== 0) {
    registrarResolucion(llamada, ambito, referencia, "exact", exactas);
    if (exactas.length === 1) {
      return exactas[0] as Candidato;
    }
    throw ambiguo(referencia, exactas, ambito);
  }

  // Cero exactas: segundo intento con coincidencia parcial. Un agente que
  // escribe "HU-25" cuando el titulo es "Revisar HU-25" acierta aca.
  const parciales = candidatos.filter(
    (candidato) =>
      normalizar(candidato.label).includes(aguja) ||
      (candidato.alias ?? []).some((alias) => normalizar(alias).includes(aguja)),
  );
  // Cero exactas ya es informacion: la busqueda que cuenta es la parcial, y es
  // la que se registra. Emitir tambien "exact con 0" duplicaria cada linea de
  // este camino sin decir nada que "partial" no diga.
  registrarResolucion(llamada, ambito, referencia, "partial", parciales);
  if (parciales.length === 1) {
    return parciales[0] as Candidato;
  }
  if (parciales.length > 1) {
    throw ambiguo(referencia, parciales, ambito);
  }

  throw noEncontrada(referencia, candidatos, ambito);
}
