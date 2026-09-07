import type { DomainErrorCode } from "../domain/errors.js";
import { DomainError } from "../domain/errors.js";

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

export interface AmbitoResolucion {
  /** "tarea", "tablero", "columna": aparece en los mensajes de error. */
  entidad: string;
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
 * Devuelve el candidato que corresponde a la referencia, o lanza el
 * `DomainError` que el agente necesita para corregirse.
 *
 * Un UUID no se busca contra la lista: se devuelve un candidato sintetico con
 * ese id. Es lo que dice la 8.3.1 ("se usa directamente") y ademas es lo que
 * hace que resolver por id no dependa de haber enumerado el ambito entero.
 */
export function resolverReferencia(
  referencia: string,
  candidatos: readonly Candidato[],
  ambito: AmbitoResolucion,
): Candidato {
  if (esUuid(referencia)) {
    return { id: referencia.trim(), label: referencia.trim() };
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
  if (exactas.length === 1) {
    return exactas[0] as Candidato;
  }
  if (exactas.length > 1) {
    throw ambiguo(referencia, exactas, ambito);
  }

  // Cero exactas: segundo intento con coincidencia parcial. Un agente que
  // escribe "HU-25" cuando el titulo es "Revisar HU-25" acierta aca.
  const parciales = candidatos.filter(
    (candidato) =>
      normalizar(candidato.label).includes(aguja) ||
      (candidato.alias ?? []).some((alias) => normalizar(alias).includes(aguja)),
  );
  if (parciales.length === 1) {
    return parciales[0] as Candidato;
  }
  if (parciales.length > 1) {
    throw ambiguo(referencia, parciales, ambito);
  }

  throw noEncontrada(referencia, candidatos, ambito);
}
