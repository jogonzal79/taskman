import type { Priority } from "@taskman/core";

/**
 * Las cuatro prioridades con su texto en pantalla, para el selector del panel.
 *
 * VIVE EN SU PROPIO MODULO porque lo importa un COMPONENTE DE CLIENTE
 * (`task-editor.tsx`), y ese import tiene que poder cruzar sin arrastrar nada
 * detras. Cruza solo esta lista: `Priority` entra como `import type`, que
 * `verbatimModuleSyntax` borra en la compilacion, asi que el nucleo no aparece en
 * el bundle del navegador. Comprobado en `static/`, igual que con el QuickAdd.
 *
 * EL MAPA ES UN `Record<Priority, string>` Y ESO ES EL MECANISMO, no decoracion:
 * si `Priority` gana un valor y nadie le pone texto, esto NO COMPILA (TS2741).
 * Es la misma salvaguarda que usa el mapeo de errores de `lib/http.ts`, y por el
 * mismo motivo: una prioridad sin texto saldria como una opcion vacia en el
 * selector, que es un fallo que solo se ve mirando.
 *
 * EL ORDEN ES EL DE DECLARACION, de mas urgente a menos. Las claves no son
 * enteras, asi que `Object.keys` las devuelve en el orden en que se escribieron:
 * el selector se lee de arriba abajo como la escala. Y al derivar la lista del
 * mapa en vez de escribirla aparte, una prioridad nueva aparece sola en el
 * selector en lugar de faltar en silencio.
 */
const TEXTO: Record<Priority, string> = {
  URGENT: "Urgente",
  HIGH: "Alta",
  MEDIUM: "Media",
  LOW: "Baja",
};

/** El valor de una opcion del selector. Es el tipo del dominio, sin traducir. */
export type OpcionDePrioridad = Priority;

export const PRIORIDADES: ReadonlyArray<{ valor: Priority; texto: string }> = (
  Object.keys(TEXTO) as Priority[]
).map((valor) => ({ valor, texto: TEXTO[valor] }));
