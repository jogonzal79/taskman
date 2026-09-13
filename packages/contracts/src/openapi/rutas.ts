import type { z } from "zod";

import { consultaDeAuditoria } from "../audit";
import { parametrosDeTablero } from "../board";
import { consultaDeBorradoDeColumna, parametrosDeColumna } from "../column";
import type { CodigoDeError } from "../error";
import { consultaDeListado } from "../pagination";
import { consultaDeBusqueda, consultaDeTareas, parametrosDeTarea } from "../task";
import type { ComponenteId } from "./componentes";

export type Metodo = "get" | "post" | "patch" | "delete";

/** Los tres scopes de la 7.2. `null` es el unico endpoint sin autenticacion. */
export type Scope = "read" | "write" | "delete";

export interface Respuesta {
  readonly estado: number;
  /**
   * Ausente: la respuesta NO tiene cuerpo. Hoy son solo los tres 204, y desde que
   * GET /api/health publica su esquema no hay ninguna respuesta con cuerpo que no
   * salga de uno.
   */
  readonly componente?: ComponenteId;
}

export interface Ruta {
  readonly metodo: Metodo;
  /** Con los parametros entre llaves, como los escribe OpenAPI. */
  readonly ruta: string;
  /** La columna "Uso" de la tabla de la 6.2, verbatim. */
  readonly resumen: string;
  /** La columna "Scope" de la 6.2. Lo exige `conAuth` en el handler. */
  readonly scope: Scope | null;
  /** La columna "RF" de la 6.2, cuando la tiene. */
  readonly rf?: readonly string[];
  readonly path?: z.ZodType;
  readonly consulta?: z.ZodType;
  readonly cuerpo?: ComponenteId;
  /** Uno de los tres POST de la 6.5, los que aceptan `Idempotency-Key`. */
  readonly idempotente?: true;
  readonly respuestas: readonly Respuesta[];
  /**
   * Los codigos de dominio PROPIOS de este endpoint. No van los que se deducen:
   * VALIDATION_ERROR lo agrega cualquier endpoint con entrada, UNAUTHENTICATED,
   * FORBIDDEN_SCOPE e INTERNAL_ERROR los agrega cualquiera con scope, e
   * IDEMPOTENCY_MISMATCH los tres idempotentes. Ver `erroresDe`.
   */
  readonly errores?: readonly CodigoDeError[];
}

/**
 * LA TABLA. Los 17 endpoints de la 6.2, en su orden.
 *
 * Es la unica parte del generador escrita a mano, y es a proposito: un esquema
 * Zod no sabe en que ruta se valida ni con que verbo, y este paquete es una hoja
 * del grafo (3.3) —no puede leer `apps/web/app` para averiguarlo—. Lo que hay
 * aca es el CABLEADO: metodo, ruta, scope y que esquema va en cada sitio. Ningun
 * campo, tipo ni tope se repite: todos salen de los esquemas referenciados, asi
 * que un cambio en uno aparece en openapi.json sin tocar esta tabla.
 *
 * Lo que si puede desfasarse es lo que no sale de ningun esquema: el scope, la
 * lista de codigos de error y el resumen. El scope lo declara `conAuth(...)` en
 * el handler y la lista de errores sale de los comentarios de cada handler y de
 * los `DomainError` de los servicios; los dos estan en `apps/web` y en
 * `packages/core`, fuera del alcance de este paquete. El comando de CLAUDE.md
 * que lista rutas con su `conAuth` es el contraste para el scope.
 */
export const RUTAS = [
  {
    metodo: "get",
    ruta: "/api/boards",
    resumen: "Listar tableros",
    scope: "read",
    consulta: consultaDeListado,
    respuestas: [{ estado: 200, componente: "ListadoDeTableros" }],
  },
  {
    metodo: "post",
    ruta: "/api/boards",
    resumen: "Crear tablero (con columnas por defecto)",
    scope: "write",
    rf: ["RF-01"],
    cuerpo: "CrearTablero",
    idempotente: true,
    // Devuelve el tablero CON sus columnas, no el tablero solo: las cuatro
    // columnas de la 4.3 son lo que este endpoint crea ademas del tablero.
    respuestas: [{ estado: 201, componente: "TableroDetallado" }],
    errores: ["NAME_REQUIRED", "NAME_TOO_LONG", "DESCRIPTION_TOO_LONG"],
  },
  {
    metodo: "get",
    ruta: "/api/boards/{id}",
    resumen: "Tablero con columnas y recuento de tareas",
    scope: "read",
    path: parametrosDeTablero,
    respuestas: [{ estado: 200, componente: "TableroDetallado" }],
    errores: ["BOARD_NOT_FOUND"],
  },
  {
    metodo: "patch",
    ruta: "/api/boards/{id}",
    resumen: "Actualizar nombre o descripcion",
    scope: "write",
    path: parametrosDeTablero,
    cuerpo: "ActualizarTablero",
    // El tablero SOLO, sin columnas ni recuentos: un patch de nombre o
    // descripcion no toca ninguna columna.
    respuestas: [{ estado: 200, componente: "Tablero" }],
    errores: ["BOARD_NOT_FOUND", "NAME_REQUIRED", "NAME_TOO_LONG", "DESCRIPTION_TOO_LONG"],
  },
  {
    metodo: "delete",
    ruta: "/api/boards/{id}",
    resumen: "Eliminar tablero en cascada",
    scope: "delete",
    path: parametrosDeTablero,
    respuestas: [{ estado: 204 }],
    errores: ["BOARD_NOT_FOUND"],
  },
  {
    metodo: "post",
    ruta: "/api/boards/{id}/columns",
    resumen: "Crear columna",
    scope: "write",
    rf: ["RF-02"],
    path: parametrosDeTablero,
    cuerpo: "CrearColumna",
    idempotente: true,
    respuestas: [{ estado: 201, componente: "ColumnaConOrden" }],
    errores: [
      "BOARD_NOT_FOUND",
      "DUPLICATE_KEY",
      "COLUMN_KEY_REQUIRED",
      "COLUMN_KEY_TOO_LONG",
      "NAME_REQUIRED",
      "NAME_TOO_LONG",
      "INVALID_ORDER",
    ],
  },
  {
    metodo: "patch",
    ruta: "/api/columns/{id}",
    resumen: "Renombrar o reordenar columna",
    scope: "write",
    path: parametrosDeColumna,
    cuerpo: "ActualizarColumna",
    respuestas: [{ estado: 200, componente: "ColumnaConOrden" }],
    errores: ["COLUMN_NOT_FOUND", "NAME_REQUIRED", "NAME_TOO_LONG", "INVALID_ORDER"],
  },
  {
    metodo: "delete",
    ruta: "/api/columns/{id}",
    resumen: "Eliminar columna (con reassign_to opcional)",
    scope: "delete",
    path: parametrosDeColumna,
    consulta: consultaDeBorradoDeColumna,
    respuestas: [{ estado: 204 }],
    errores: [
      "COLUMN_NOT_FOUND",
      "COLUMN_NOT_EMPTY",
      "COLUMN_NOT_IN_BOARD",
      "INVALID_REASSIGN_TARGET",
    ],
  },
  {
    metodo: "get",
    ruta: "/api/tasks",
    resumen: "Listar y filtrar tareas",
    scope: "read",
    rf: ["RF-04"],
    consulta: consultaDeTareas,
    respuestas: [{ estado: 200, componente: "ListadoDeTareas" }],
    // Resolver `column_key` dentro del tablero es lo unico que puede fallar
    // por datos: no comprueba que el tablero exista.
    errores: ["COLUMN_NOT_FOUND", "COLUMN_KEY_TOO_LONG"],
  },
  {
    metodo: "get",
    ruta: "/api/tasks/search",
    resumen: "Busqueda por texto",
    scope: "read",
    rf: ["RF-09"],
    consulta: consultaDeBusqueda,
    respuestas: [{ estado: 200, componente: "ListadoDeCoincidencias" }],
  },
  {
    metodo: "post",
    ruta: "/api/tasks",
    resumen: "Crear tarea",
    scope: "write",
    rf: ["RF-03"],
    cuerpo: "CrearTarea",
    idempotente: true,
    respuestas: [{ estado: 201, componente: "Tarea" }],
    errores: [
      "BOARD_NOT_FOUND",
      "COLUMN_NOT_FOUND",
      "COLUMN_NOT_IN_BOARD",
      "TITLE_REQUIRED",
      "TITLE_TOO_LONG",
      "COLUMN_KEY_REQUIRED",
      "COLUMN_KEY_TOO_LONG",
      "INVALID_ORDER",
    ],
  },
  {
    metodo: "get",
    ruta: "/api/tasks/{id}",
    resumen: "Consultar tarea",
    scope: "read",
    path: parametrosDeTarea,
    respuestas: [{ estado: 200, componente: "Tarea" }],
    errores: ["TASK_NOT_FOUND"],
  },
  {
    metodo: "patch",
    ruta: "/api/tasks/{id}",
    resumen: "Actualizar campos editables",
    scope: "write",
    rf: ["RF-05"],
    path: parametrosDeTarea,
    cuerpo: "ActualizarTarea",
    respuestas: [{ estado: 200, componente: "Tarea" }],
    errores: ["TASK_NOT_FOUND", "TITLE_REQUIRED", "TITLE_TOO_LONG"],
  },
  {
    metodo: "delete",
    ruta: "/api/tasks/{id}",
    resumen: "Eliminar tarea",
    scope: "delete",
    rf: ["RF-06"],
    path: parametrosDeTarea,
    respuestas: [{ estado: 204 }],
    errores: ["TASK_NOT_FOUND"],
  },
  {
    metodo: "post",
    ruta: "/api/tasks/{id}/move",
    resumen: "Mover entre columnas y posiciones",
    scope: "write",
    rf: ["RF-07", "RF-08"],
    path: parametrosDeTarea,
    cuerpo: "MoverTarea",
    respuestas: [{ estado: 200, componente: "ResultadoDeMovimiento" }],
    errores: [
      "TASK_NOT_FOUND",
      "COLUMN_NOT_FOUND",
      "COLUMN_NOT_IN_BOARD",
      "COLUMN_KEY_TOO_LONG",
      "INVALID_ORDER",
    ],
  },
  {
    metodo: "get",
    ruta: "/api/audit",
    resumen: "Consultar registro de auditoria",
    scope: "read",
    rf: ["RF-10"],
    consulta: consultaDeAuditoria,
    respuestas: [{ estado: 200, componente: "ListadoDeAuditoria" }],
  },
  {
    metodo: "get",
    ruta: "/api/health",
    resumen: "Sonda de salud (sin autenticacion)",
    scope: null,
    // Un esquema POR ESTADO: el 200 y el 503 son dos formas distintas, no una
    // con campos opcionales. Ver `packages/contracts/src/health.ts`.
    //
    // Sigue siendo el unico endpoint sin `security` y sin codigos de error de la
    // 6.4: no autentica, asi que no tiene 401, 403 ni 429. Lo que ya NO es
    // excepcion es el X-Request-Id, que ahora emite como todos (6.1).
    respuestas: [
      { estado: 200, componente: "Salud" },
      { estado: 503, componente: "SaludDegradada" },
    ],
  },
] as const satisfies readonly Ruta[];
