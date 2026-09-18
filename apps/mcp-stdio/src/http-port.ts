import { randomUUID } from "node:crypto";

import {
  coincidencia as esquemaCoincidencia,
  columnaConOrden as esquemaColumnaConOrden,
  errorDeApi,
  listadoDe,
  listadoDeTableros,
  listadoDeTareas,
  resultadoDeMovimiento as esquemaMovimiento,
  tableroDetallado as esquemaTableroDetallado,
  tarea as esquemaTarea,
  type Columna,
  type ColumnaDetallada,
  type Tablero,
  type TableroDetallado,
  type Tarea,
} from "@taskman/contracts";
import {
  DomainError,
  esCodigoDeDominio,
  isDomainError,
  LOGGER_NULO,
  type ActorContext,
  type Board,
  type BoardDetail,
  type Column,
  type CreateBoardInput,
  type CreateColumnInput,
  type CreateTaskInput,
  type ListBoardsQuery,
  type ListTasksQuery,
  type Logger,
  type MoveResult,
  type MoveTarget,
  type Page,
  type Scope,
  type SearchScope,
  type Task,
  type TaskManagerPort,
  type TaskMatch,
  type UpdateTaskInput,
} from "@taskman/core";
import type { z } from "zod";

/**
 * `TaskManagerPort` resuelto contra la API REST con una API key: el HttpPort de
 * la ADR-003 y el modo `MCP_PORT_MODE=http` de la 8.1.
 *
 * POR QUE VIVE EN `apps/mcp-stdio` Y NO EN `packages/core/src/mcp`, al lado de
 * `CorePort`. La 3.2 lo prohibe con todas las letras —"packages/core NO importa
 * Next, ni el SDK de MCP, ni ningun modulo de HTTP"— y ademas lo prohibe su
 * PRUEBA, que es la parte que no admite interpretacion: "si un servicio no se
 * puede ejercitar en una prueba unitaria sin levantar un servidor HTTP, la regla
 * esta rota". Esta clase no se puede ejercitar sin un servidor HTTP: ES el
 * cliente de uno. O sea que la 3.2 no la excluye por una cuestion de imports que
 * se pudiera esquivar inyectando `fetch`, sino por lo que la clase hace.
 *
 * De las tres alternativas, se eligio esta:
 *
 * - `apps/mcp-stdio` (ELEGIDA). La 3.3 ya le permite importar `contracts` y
 *   `core`, que es exactamente lo que hace falta, asi que no hay ninguna regla
 *   que mover ni ninguna fila nueva en la tabla de dependencias. Y sobre todo:
 *   la tabla de la 8.1 le da a HttpPort UN SOLO consumidor —stdio contra una API
 *   remota, el escenario "caso habitual"—, porque el cliente MCP remoto sobre
 *   /mcp usa CorePort. Un puerto con un unico consumidor vive con su consumidor.
 * - Un paquete nuevo (`packages/api-client`). Seria la casa correcta el dia que
 *   haya un SEGUNDO consumidor; hoy seria una fila mas en la 3.3 y un paquete
 *   con una clase, para nadie. Es el mismo criterio con el que `CorePort` deja
 *   fuera de `TaskManagerPort` todo lo que solo usa REST.
 * - `packages/core`. Descartada por la 3.2, arriba.
 *
 * CONSECUENCIA CONOCIDA de la eleccion, para que nadie la descubra sola: la
 * prueba de integracion de esta clase NO puede vivir aca, porque el servidor
 * contra el que hay que correrla son los Route Handlers de `apps/web` y esta app
 * no la puede importar. Vive en `apps/web/test/http-port.test.ts`, que si ve las
 * dos puntas del cable, con `@taskman/mcp-stdio` declarado ahi como
 * devDependency. Es una dependencia de PRUEBA y no de ejecucion: el grafo de la
 * 3.3 sigue siendo el que describe la tabla.
 *
 * LO QUE ESTA CLASE NO HACE, y es la mitad de su valor: no valida reglas, no
 * resuelve referencias por nombre y no decide nada de negocio. La autoridad es
 * el servidor (ADR-003: "toda validacion de autorizacion y toda regla de negocio
 * DEBE estar en el nucleo o en la API"). Aca solo se arma la peticion, se traduce
 * la respuesta a los tipos del dominio y se traduce el error de la 6.4 al
 * `DomainError` que habria lanzado `CorePort`.
 */

/**
 * El id local de una peticion HTTP, con la MISMA forma que el del servidor
 * (`req_` mas un UUID v4 sin guiones).
 *
 * Es una segunda definicion de ese formato y no se puede evitar: la primera vive
 * en `apps/web/lib/http.ts`, que es el borde REST, y esta app no puede importar
 * de la otra. Que la forma coincida es a proposito: la linea de log empareja los
 * dos ids, y dos formatos distintos ahi harian dudar de cual es cual.
 */
function nuevoRequestIdLocal(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

export interface OpcionesHttpPort {
  /** Raiz de la API, con o sin barra final: TASKMAN_API_URL de la 11.2. */
  readonly baseUrl: string;
  /** La clave de la 7.1, tal cual se emite. Viaja como `Authorization: Bearer`. */
  readonly apiKey: string;
  /** Donde va la linea por peticion de la 11.1. Ausente, no se escribe nada. */
  readonly logger?: Logger;
  /**
   * El `fetch` a usar. Existe para la prueba, que apunta a un servidor efimero,
   * y NO para sustituir la red por un doble: lo que se inyecta sigue siendo un
   * `fetch` de verdad contra un socket de verdad.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/** Lo que una peticion necesita saber, ya resuelto por el llamador. */
interface Peticion<T> {
  readonly metodo: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absoluta desde la raiz, con el `/api` incluido. Sin query string. */
  readonly ruta: string;
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly cuerpo?: unknown;
  /** El esquema del contrato con el que se lee la respuesta. Ausente: 204. */
  readonly esquema?: z.ZodType<T>;
  /**
   * El contexto de la invocacion MCP que causo esta peticion, cuando lo hay.
   * SOLO para la linea de log: NO viaja al servidor (ver O4, mas abajo).
   */
  readonly ctx?: ActorContext;
}

/**
 * El recurso contra el que se sondean los scopes (ver `descubrirScopes`).
 *
 * El id NO ES UN UUID a proposito, y es lo unico que hace que estas tres
 * peticiones sean seguras: los tres handlers de `/api/tasks/{id}` validan el
 * parametro de ruta antes de cualquier otra cosa y devuelven 400, asi que ni
 * siquiera llegan a mirar la base. El nombre se lee en el log del servidor y
 * dice para que fue: tres lineas con `/api/tasks/sonda-de-scope` al arrancar un
 * agente no son un cliente roto.
 */
const RUTA_SONDA = "/api/tasks/sonda-de-scope";

interface Sonda {
  readonly scope: Scope;
  readonly metodo: "GET" | "PATCH" | "DELETE";
}

/**
 * Un verbo por scope, los tres sobre el MISMO recurso: lo unico que cambia entre
 * las tres peticiones es el scope que `conAuth` les exige (`read` en el GET,
 * `write` en el PATCH, `delete` en el DELETE). El orden es el de `SCOPES`, para
 * que la lista que sale de aca se lea igual que la que emite `apikey:create`.
 */
const SONDAS: readonly Sonda[] = [
  { scope: "READ", metodo: "GET" },
  { scope: "WRITE", metodo: "PATCH" },
  { scope: "DELETE", metodo: "DELETE" },
];

type Veredicto = "concedido" | "denegado" | "sin-clave" | "indeterminado";

export interface ScopesDeLaClave {
  /** Los que la clave tiene, mas los que no se pudieron medir. */
  readonly scopes: readonly Scope[];
  /**
   * Los que se dieron por concedidos sin poder medirlos. Vacio es el caso
   * normal; con algo adentro, el catalogo puede tener de mas y quien arranca
   * tiene que poder verlo en el log.
   */
  readonly indeterminados: readonly Scope[];
}

export class HttpPort implements TaskManagerPort {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #logger: Logger;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opciones: OpcionesHttpPort) {
    const base = opciones.baseUrl.trim();

    // Falla al construir y no en la primera llamada, por lo mismo que el pepper
    // del `ApiKeyService`: una configuracion vacia produce peticiones a una URL
    // sin sentido o sin credencial, y el sintoma seria un 401 o un ECONNREFUSED
    // indistinguible de un servidor caido.
    if (base === "") {
      throw new Error("HttpPort necesita una baseUrl: definí TASKMAN_API_URL (11.2).");
    }
    if (opciones.apiKey.trim() === "") {
      throw new Error("HttpPort necesita una apiKey: definí TASKMAN_API_KEY (7.1, 11.2).");
    }

    // Sin barra final: todas las rutas se escriben empezando por `/api/`.
    this.#baseUrl = base.replace(/\/+$/, "");
    this.#apiKey = opciones.apiKey;
    this.#logger = opciones.logger ?? LOGGER_NULO;
    this.#fetch = opciones.fetch ?? globalThis.fetch;
  }

  // --- El unico punto por el que sale una peticion ---------------------------

  /**
   * Arma la peticion, la manda, deja la linea de la 11.1 y traduce la respuesta.
   *
   * Que sea uno solo es lo que hace que la traduccion de errores y la linea de
   * log no se puedan olvidar en un metodo nuevo, igual que `definirHandler` es
   * el unico ejecutor de herramientas del nucleo.
   *
   * O4, EL REQUEST_ID, tiene sus dos mitades aca:
   *
   * 1. NO se manda el id del agente al servidor. No hay cabecera `X-Request-Id`
   *    en la peticion, y es una decision y no un olvido: el `request_id` que
   *    queda en `audit_log` tiene que ser el que genero el servidor, porque
   *    aceptar el que elige un cliente es aceptar que el cliente escriba en la
   *    auditoria. Se trae el del servidor, que la 6.1 garantiza en TODA
   *    respuesta.
   * 2. El id del servidor entra en `details.request_id` del error (ver
   *    `traducirError`) y en ESTA linea de log junto al id local, que es lo que
   *    hace que la union exista tambien del lado del proceso stdio: con el id
   *    que el agente ve en un error se encuentra aca la peticion, y con el id
   *    local se encuentra la invocacion que la pidio.
   */
  async #pedir<T>(peticion: Peticion<T>): Promise<T> {
    const requestId = nuevoRequestIdLocal();
    const url = this.#url(peticion.ruta, peticion.query);
    const comienzo = performance.now();

    const respuesta = await this.#fetch(url, {
      method: peticion.metodo,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
        ...(peticion.cuerpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(peticion.cuerpo === undefined ? {} : { body: JSON.stringify(peticion.cuerpo) }),
    });

    const serverRequestId = respuesta.headers.get("x-request-id");

    this.#logger.info(
      {
        evt: "http.request",
        method: peticion.metodo,
        route: peticion.ruta,
        status: respuesta.status,
        durationMs: Math.round(performance.now() - comienzo),
        requestId,
        serverRequestId,
        // Solo en las escrituras, que son las unicas que reciben `ActorContext`
        // (7.4: las lecturas no se auditan). Donde esta, es el MISMO valor que
        // el `requestId` de la linea `mcp.tool` de la invocacion.
        ...(peticion.ctx === undefined ? {} : { toolRequestId: peticion.ctx.requestId }),
      },
      `${peticion.metodo} ${peticion.ruta}: ${respuesta.status}`,
    );

    if (!respuesta.ok) {
      throw await traducirError(respuesta, serverRequestId, peticion);
    }

    // Un 204 no tiene cuerpo (DELETE /api/tasks/{id}). El unico metodo del
    // puerto que cae aca devuelve void, asi que no hay nada que leer ni validar.
    if (peticion.esquema === undefined) {
      return undefined as T;
    }

    const salida = peticion.esquema.safeParse(await respuesta.json());

    if (!salida.success) {
      /**
       * El servidor contesto 2xx con algo que no es el contrato. NO es un
       * `DomainError`: no hay nada que el agente pueda corregir, y presentarselo
       * como uno seria pedirle que arregle un desfase entre dos versiones del
       * proyecto. Sube como fallo inesperado, que es lo que es, y la traza —con
       * el id del servidor— queda en la linea `mcp.tool`.
       */
      throw new Error(
        `La respuesta de ${peticion.metodo} ${peticion.ruta} no cumple el contrato ` +
          `(request_id del servidor: ${serverRequestId ?? "ausente"}): ` +
          salida.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }

    return salida.data;
  }

  #url(ruta: string, query: Peticion<unknown>["query"]): string {
    const url = new URL(`${this.#baseUrl}${ruta}`);

    for (const [clave, valor] of Object.entries(query ?? {})) {
      if (valor === undefined) {
        continue;
      }
      // Un array se repite, que es como la 6.3.2 escribe `priority`: los
      // repetibles del borde REST son parametros repetidos, no listas separadas
      // por comas.
      for (const uno of Array.isArray(valor) ? valor : [valor as string]) {
        url.searchParams.append(clave, uno);
      }
    }

    return url.toString();
  }

  // --- Los scopes de la clave (8.1) ------------------------------------------

  /**
   * Los scopes de la 7.2 que tiene la clave configurada, MEDIDOS contra el
   * servidor con tres peticiones que no pueden tocar nada.
   *
   * PARA QUE. La 8.1 pide que el filtrado del catalogo ocurra en el LISTADO y no
   * solo en la ejecucion, "para que el agente no planifique acciones que no
   * puede completar". En modo core `apps/mcp-stdio` monta con los tres scopes
   * porque no hay clave de la que leerlos; en modo http la hay, y sin esto el
   * agente veria las once herramientas y descubriria el limite recien al
   * ejecutar, con un FORBIDDEN_SCOPE. Util, pero no es lo que el DEBE pide.
   *
   * DE DONDE SALEN, que es la decision de este bloque. No hay endpoint que
   * devuelva los scopes de una clave: los diecisiete de la 6.2 son de tableros,
   * columnas, tareas, auditoria y health, y ninguno habla de la credencial. Las
   * tres opciones eran:
   *
   * - UN ENDPOINT NUEVO de introspeccion (`GET /api/keys/current`). Es el diseno
   *   limpio y es lo que haria un producto, pero es superficie publica que la
   *   6.2 no tiene: un endpoint numero dieciocho, con su contrato, su OpenAPI,
   *   sus pruebas y su scope —¿cual?, porque una clave sin `read` tambien
   *   necesita leerse a si misma—. No se escribio.
   * - UNA VARIABLE `MCP_SCOPES` en el `.mcp.json`. Es lo mas barato y es lo
   *   peor: seria una DECLARACION del cliente sobre una credencial que no emitio
   *   el, o sea justo lo que el paso 12 saco del cable al derivar `actor_type`
   *   de la clave. Declarar de menos esconde herramientas que si se podian usar,
   *   y declarar de mas devuelve el problema que esto viene a resolver, con un
   *   dato mas que puede envejecer.
   * - SONDEAR (ELEGIDA). El servidor ya sabe la respuesta y ya la dice: el 403
   *   FORBIDDEN_SCOPE de `conAuth` es exactamente "esta clave no tiene este
   *   scope". Lo unico que falta es preguntarselo sin hacer nada.
   *
   * POR QUE LA SONDA NO PUEDE TOCAR NADA, que es lo que la hace aceptable. El id
   * de `RUTA_SONDA` NO ES UN UUID, asi que ningun handler puede encontrar una
   * tarea con el: no existe hoy ni puede existir manana —los UUID los genera la
   * aplicacion— y el handler lo rechaza con 400 antes de leer el cuerpo y antes
   * de tocar la base. No es "improbable que borre algo", es imposible.
   *
   * POR QUE LA RESPUESTA MIDE EL SCOPE Y NADA MAS: `conAuth` resuelve el scope
   * ANTES de invocar al handler, asi que el 403 y el 400 se excluyen. 403 es "no
   * tenes el scope"; CUALQUIER otra cosa —el 400 del id invalido— significa que
   * el scope alcanzo y la peticion llego al handler. Se sondea con los tres
   * verbos del MISMO recurso para que la unica variable entre las tres sea el
   * scope que cada uno exige.
   *
   * Se lee el CODIGO de dominio de cada respuesta y no el `granted_scopes` que el 403 trae
   * en `details`, aunque ese traeria la lista entera de una: `granted_scopes` es
   * un agregado de este repo sobre la 6.4 y no parte del contrato, mientras que
   * "403 es scope insuficiente" si lo es. Tres medidas independientes de una
   * cosa cada una, en vez de una medida de las tres que depende de un campo mas.
   *
   * LO QUE CUESTA: tres peticiones al arrancar, un lugar del cupo de lectura y
   * dos del de escritura (7.3, `CUBO_POR_SCOPE` cobra `delete` del de
   * escritura). Van en paralelo, asi que es un viaje de ida y vuelta.
   *
   * SI UNA SONDA NO SE PUEDE INTERPRETAR —429, 500, la red caida— su scope se da
   * por CONCEDIDO y se devuelve en `indeterminados` para que el arranque lo
   * registre. Es la direccion correcta del error: el agente vuelve a ver la
   * herramienta y a recibir el 403 al ejecutarla, o sea el comportamiento de
   * antes de este paso, en vez de perder herramientas que si tiene por un
   * servidor que tosio una vez.
   *
   * UN 401 SI IMPIDE ARRANCAR, y por eso este metodo lanza: significa que el
   * servidor rechazo la clave, no que no se pudo medir. Arrancar igual daria un
   * servidor MCP que anuncia once herramientas y falla las once, que es el
   * "fallo posterior en tiempo de ejecucion" que la 11.2 manda evitar. Que lo
   * vea el servidor y no el esquema no lo hace otra cosa: TASKMAN_API_KEY tiene
   * un valor invalido.
   */
  async descubrirScopes(): Promise<ScopesDeLaClave> {
    const veredictos = await Promise.all(
      SONDAS.map(async (sonda) => ({ scope: sonda.scope, veredicto: await this.#sondear(sonda) })),
    );

    if (veredictos.some(({ veredicto }) => veredicto === "sin-clave")) {
      throw new Error(
        `El servidor de ${this.#baseUrl} rechazo la clave con 401: revisa TASKMAN_API_KEY ` +
          "(7.1, 11.2). Una clave revocada o de otra instalacion da lo mismo que una mal copiada.",
      );
    }

    return {
      scopes: veredictos.filter((v) => v.veredicto !== "denegado").map((v) => v.scope),
      indeterminados: veredictos.filter((v) => v.veredicto === "indeterminado").map((v) => v.scope),
    };
  }

  /** Una sonda. Nunca lanza: lo que no se entiende es `indeterminado`. */
  async #sondear(sonda: Sonda): Promise<Veredicto> {
    try {
      await this.#pedir({ metodo: sonda.metodo, ruta: RUTA_SONDA });

      // Inalcanzable con un id que no es un UUID, pero si algun dia lo fuera, un
      // 2xx significa que el scope alcanzo, que es lo que se esta midiendo.
      return "concedido";
    } catch (error: unknown) {
      if (!isDomainError(error)) {
        return "indeterminado";
      }

      switch (error.code) {
        case "FORBIDDEN_SCOPE":
          return "denegado";
        case "UNAUTHENTICATED":
          return "sin-clave";
        case "VALIDATION_ERROR":
          // El 400 del id que no es un UUID: la peticion PASO el control de
          // scope y llego al handler, que es lo unico que se estaba midiendo.
          return "concedido";
        default:
          /**
           * Todo lo demas es indeterminado, y la lista blanca es a proposito.
           * Un 429 se cobra ANTES de resolver el scope (ver `atender` en
           * `apps/web/lib/auth.ts`), asi que no llego a mirarlo; un 500 puede
           * venir del handler o de antes de autenticar. Ninguno dice que la
           * clave no tenga el scope: dicen que no se pudo preguntar. Y si algun
           * dia el handler cambiara el codigo con que rechaza un id invalido,
           * esto degrada a "concedido sin medir" con su linea de warn, en vez de
           * esconder una herramienta que la clave si tenia.
           */
          return "indeterminado";
      }
    }
  }

  // --- Tableros --------------------------------------------------------------

  async listBoards(query: ListBoardsQuery): Promise<Page<Board>> {
    const pagina = await this.#pedir({
      metodo: "GET",
      ruta: "/api/boards",
      query: aQuery({ limit: query.limit, cursor: query.cursor }),
      esquema: listadoDeTableros,
    });

    return { items: pagina.items.map(aTablero), nextCursor: pagina.next_cursor };
  }

  async getBoard(boardId: string): Promise<BoardDetail> {
    return aTableroDetallado(
      await this.#pedir({
        metodo: "GET",
        ruta: `/api/boards/${encodeURIComponent(boardId)}`,
        esquema: esquemaTableroDetallado,
      }),
    );
  }

  /**
   * `ctx` NO se manda, y es del paso 12 y no un olvido: el actor de la
   * auditoria en este modo lo deriva el servidor de la clave que autentico
   * (`contextoDeApi`), asi que todo lo que este proceso escriba queda como API
   * con la etiqueta de la clave. Lo mismo vale para las otras cinco escrituras.
   */
  async createBoard(input: CreateBoardInput, ctx: ActorContext): Promise<BoardDetail> {
    return aTableroDetallado(
      await this.#pedir({
        metodo: "POST",
        ruta: "/api/boards",
        ctx,
        cuerpo: {
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.columns === undefined
            ? {}
            : { columns: input.columns.map((columna) => ({ name: columna.name, key: columna.key })) }),
        },
        esquema: esquemaTableroDetallado,
      }),
    );
  }

  // --- Columnas --------------------------------------------------------------

  /**
   * Devuelve la columna SOLA, como el puerto: el endpoint contesta ademas el
   * orden final del tablero (`ColumnaConOrden`) y aca se descarta, igual que
   * `ColumnService.create` lo descarta en modo core. Quien lo necesita —la
   * herramienta `create_column`— lo vuelve a pedir por el puerto, y asi los dos
   * modos hacen el mismo numero de llamadas al nucleo.
   */
  async createColumn(input: CreateColumnInput, ctx: ActorContext): Promise<Column> {
    const salida = await this.#pedir({
      metodo: "POST",
      ruta: `/api/boards/${encodeURIComponent(input.boardId)}/columns`,
      ctx,
      cuerpo: {
        name: input.name,
        key: input.key,
        ...(input.position === undefined ? {} : { position: input.position }),
      },
      esquema: esquemaColumnaConOrden,
    });

    return aColumna(salida.column);
  }

  // --- Tareas ----------------------------------------------------------------

  async listTasks(query: ListTasksQuery): Promise<Page<Task>> {
    const pagina = await this.#pedir({
      metodo: "GET",
      ruta: "/api/tasks",
      query: aQuery({
        limit: query.limit,
        cursor: query.cursor,
        board_id: query.boardId,
        column_id: query.columnId,
        column_key: query.columnKey,
        priority: query.priority,
        due_before: aFechaIso(query.dueBefore),
        due_after: aFechaIso(query.dueAfter),
        overdue: query.overdue,
        order_by: query.orderBy === undefined ? undefined : ORDEN_HTTP[query.orderBy],
      }),
      esquema: listadoDeTareas,
    });

    return { items: pagina.items.map(aTarea), nextCursor: pagina.next_cursor };
  }

  async getTask(taskId: string): Promise<Task> {
    return aTarea(
      await this.#pedir({
        metodo: "GET",
        ruta: `/api/tasks/${encodeURIComponent(taskId)}`,
        esquema: esquemaTarea,
      }),
    );
  }

  async createTask(input: CreateTaskInput, ctx: ActorContext): Promise<Task> {
    return aTarea(
      await this.#pedir({
        metodo: "POST",
        ruta: "/api/tasks",
        ctx,
        cuerpo: {
          board_id: input.boardId,
          ...(input.columnId === undefined ? {} : { column_id: input.columnId }),
          ...(input.columnKey === undefined ? {} : { column_key: input.columnKey }),
          title: input.title,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.dueDate === undefined
            ? {}
            : { due_date: input.dueDate === null ? null : aFechaIso(input.dueDate) }),
          ...(input.position === undefined ? {} : { position: input.position }),
        },
        esquema: esquemaTarea,
      }),
    );
  }

  async updateTask(taskId: string, patch: UpdateTaskInput, ctx: ActorContext): Promise<Task> {
    return aTarea(
      await this.#pedir({
        metodo: "PATCH",
        ruta: `/api/tasks/${encodeURIComponent(taskId)}`,
        ctx,
        // Ausente y `null` son pedidos DISTINTOS (no tocar / borrar), asi que el
        // opcional va condicional y el null viaja tal cual.
        cuerpo: {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }),
          ...(patch.dueDate === undefined
            ? {}
            : { due_date: patch.dueDate === null ? null : aFechaIso(patch.dueDate) }),
        },
        esquema: esquemaTarea,
      }),
    );
  }

  async moveTask(taskId: string, target: MoveTarget, ctx: ActorContext): Promise<MoveResult> {
    const salida = await this.#pedir({
      metodo: "POST",
      ruta: `/api/tasks/${encodeURIComponent(taskId)}/move`,
      ctx,
      cuerpo: {
        ...(target.columnId === undefined ? {} : { column_id: target.columnId }),
        ...(target.columnKey === undefined ? {} : { column_key: target.columnKey }),
        position: target.position,
      },
      esquema: esquemaMovimiento,
    });

    return {
      task: aTarea(salida.task),
      fromColumnId: salida.from_column_id,
      toColumnId: salida.to_column_id,
      affectedColumns: salida.affected_columns.map((orden) => ({
        columnId: orden.column_id,
        taskOrder: orden.task_order,
      })),
    };
  }

  /** 204 sin cuerpo: no hay esquema que aplicar y no hay nada que devolver. */
  async deleteTask(taskId: string, ctx: ActorContext): Promise<void> {
    await this.#pedir<void>({
      metodo: "DELETE",
      ruta: `/api/tasks/${encodeURIComponent(taskId)}`,
      ctx,
    });
  }

  async searchTasks(text: string, scope: SearchScope): Promise<Page<TaskMatch>> {
    const pagina = await this.#pedir({
      metodo: "GET",
      ruta: "/api/tasks/search",
      query: aQuery({
        q: text,
        limit: scope.limit,
        cursor: scope.cursor,
        board_id: scope.boardId,
        column_id: scope.columnId,
      }),
      esquema: listadoDe(esquemaCoincidencia),
    });

    return {
      items: pagina.items.map(({ rank, ...tarea }) => ({ task: aTarea(tarea), rank })),
      nextCursor: pagina.next_cursor,
    };
  }
}

// --- Traduccion de errores (6.4) ---------------------------------------------

/**
 * La envoltura de la 6.4 al error que habria lanzado `CorePort`.
 *
 * ES EL CORAZON DE LA EQUIVALENCIA ENTRE LOS DOS MODOS. Un agente no deberia
 * notar por que puerta entro: el codigo, el mensaje, el `details` y el `hint`
 * los produjo el mismo nucleo del otro lado del cable, asi que se reconstruyen
 * TAL CUAL y no se reescriben. Lo unico que se agrega es `details.request_id`,
 * que es O4: el id con el que el servidor registro esa peticion, para que el
 * error que ve el agente quede unido a su fila de `audit_log` y a la linea del
 * log del servidor. Es la UNICA diferencia entre el `DomainError` de un modo y
 * el del otro, y esta medida como tal en la prueba.
 *
 * CODIGOS QUE EL NUCLEO NO PRODUCE. `esCodigoDeDominio` decide, y los cuatro de
 * la 7.x —UNAUTHENTICATED, FORBIDDEN_SCOPE, RATE_LIMITED, PAYLOAD_TOO_LARGE—
 * entraron al catalogo justamente para pasar por aca (ver `CODIGOS_DE_DOMINIO`).
 * Lo que el agente ve en cada uno es lo que el servidor escribio, que ya es lo
 * correcto y esta probado del otro lado:
 *
 * - 401 UNAUTHENTICATED: "Falta la cabecera Authorization o la clave no es
 *   valida", con el hint de como mandarla. Para el agente es un problema de
 *   configuracion de ESTE proceso, no de sus argumentos.
 * - 403 FORBIDDEN_SCOPE: `details` trae `required_scope` y `granted_scopes`, que
 *   es lo unico accionable, y el hint dice que hay que emitir otra clave.
 * - 429 RATE_LIMITED: `details` trae el cupo, la ventana y `retry_after_seconds`,
 *   y el hint dice "Espera N segundos y reintenta". Ese es el caso que obligo a
 *   no dejarlos caer en el INTERNAL_ERROR del ejecutor, cuyo texto afirma que
 *   reintentar probablemente vuelva a fallar: aca es al reves, reintentar es
 *   exactamente lo que hay que hacer.
 * - 413 PAYLOAD_TOO_LARGE: `details` trae el tope en bytes y el hint dice que se
 *   divida la operacion.
 * - 422 IDEMPOTENCY_MISMATCH: ya era del catalogo desde F2. Por MCP no se manda
 *   `Idempotency-Key`, asi que hoy no se alcanza; sigue traducido igual porque
 *   la alternativa —tratarlo distinto que a sus vecinos— seria una regla que
 *   depende de que cabeceras manda hoy este cliente.
 *
 * TODO LO DEMAS sube como fallo inesperado: el INTERNAL_ERROR de un 500, un
 * FORBIDDEN_ORIGIN que /api no produce, un cuerpo que no es la envoltura, o un
 * codigo que este proceso no conoce porque el servidor es mas nuevo. Los cuatro
 * son la misma clase de cosa —algo que el agente no puede corregir— y el
 * ejecutor los traduce a INTERNAL_ERROR con su hint, que ahi SI es cierto. El
 * mensaje lleva el id del servidor para que la traza de la linea `mcp.tool`
 * alcance para encontrar la otra punta.
 */
async function traducirError(
  respuesta: Response,
  serverRequestId: string | null,
  peticion: Pick<Peticion<unknown>, "metodo" | "ruta">,
): Promise<Error> {
  const donde = `${peticion.metodo} ${peticion.ruta}`;
  const idServidor = serverRequestId ?? "ausente";
  const cuerpo = await leerJson(respuesta);
  const sobre = errorDeApi.safeParse(cuerpo);

  if (!sobre.success) {
    return new Error(
      `${donde} respondio ${respuesta.status} con un cuerpo que no es la envoltura de la 6.4 ` +
        `(request_id del servidor: ${idServidor}).`,
    );
  }

  const { code, message, details, hint, request_id: requestIdServidor } = sobre.data.error;

  if (!esCodigoDeDominio(code)) {
    return new Error(
      `${donde} respondio ${respuesta.status} ${code}: ${message} ` +
        `(request_id del servidor: ${requestIdServidor}).`,
    );
  }

  return new DomainError(code, message, {
    // `request_id` SIEMPRE, tambien cuando el error no traia `details`: de eso
    // depende que el agente pueda nombrar la peticion que fallo.
    details: { ...(details ?? {}), request_id: requestIdServidor },
    ...(hint === undefined ? {} : { hint }),
  });
}

/** El cuerpo de un error, o `undefined` si no es JSON. Nunca lanza. */
async function leerJson(respuesta: Response): Promise<unknown> {
  try {
    return await respuesta.json();
  } catch {
    return undefined;
  }
}

// --- Traduccion de datos (6.1) -----------------------------------------------

/**
 * Los cuatro ordenes al vocabulario del borde. Es el reverso exacto de
 * `ORDEN_DE_DOMINIO` en `apps/web/app/api/tasks/route.ts`, y se escribe otra vez
 * por lo mismo que el formato del request_id: son dos procesos y ninguno importa
 * el borde del otro. Lo que lo sostiene es que las dos tablas cubren el mismo
 * enum del nucleo y el typecheck exige las cuatro claves.
 */
const ORDEN_HTTP: Record<NonNullable<ListTasksQuery["orderBy"]>, string> = {
  position: "position",
  dueDate: "due_date",
  priority: "priority",
  createdAt: "created_at",
};

/**
 * Los valores de un query string, todos a texto, descartando los ausentes.
 *
 * `undefined` se descarta y no se manda como la cadena "undefined", que es lo
 * que haria un `String(valor)` al pasar y que los cinco endpoints que leen query
 * rechazarian con un 400 desde el paso 9.
 */
function aQuery(
  valores: Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>,
): Record<string, string | readonly string[] | undefined> {
  const salida: Record<string, string | readonly string[] | undefined> = {};

  for (const [clave, valor] of Object.entries(valores)) {
    if (valor === undefined) {
      continue;
    }
    salida[clave] = Array.isArray(valor) ? valor : String(valor);
  }

  return salida;
}

/**
 * `Date` a `AAAA-MM-DD`, leyendo las partes en UTC.
 *
 * Es la misma conversion que `aFechaIso` de `apps/web/lib/tareas.ts` y por el
 * mismo motivo: leer con `getDate()` devolveria el dia ANTERIOR en cualquier
 * zona al oeste de Greenwich, que es el corrimiento clasico de este campo.
 */
function aFechaIso(fecha: Date | undefined): string | undefined {
  return fecha === undefined ? undefined : fecha.toISOString().slice(0, 10);
}

/** `AAAA-MM-DD` a `Date`, anclada a medianoche UTC. El contrato ya la valido. */
function aFechaUtc(valor: string | null): Date | null {
  return valor === null ? null : new Date(`${valor}T00:00:00.000Z`);
}

function aTablero(tablero: Tablero): Board {
  return {
    id: tablero.id,
    name: tablero.name,
    description: tablero.description,
    createdAt: new Date(tablero.created_at),
    updatedAt: new Date(tablero.updated_at),
  };
}

/**
 * El detalle descarta `task_count`, el del tablero y el de cada columna.
 *
 * No es una perdida: `BoardDetail` no los tiene porque el recuento no es un
 * atributo de la columna (ver `domain/types.ts`), y `get_board` arma el suyo
 * contando las tareas que ya pidio. Traerlos hasta el dominio obligaria a
 * `CorePort` a calcularlos en `getBoard`, que hoy no lo hace.
 */
function aTableroDetallado(tablero: TableroDetallado): BoardDetail {
  return { ...aTablero(tablero), columns: tablero.columns.map(aColumna) };
}

function aColumna(columna: Columna | ColumnaDetallada): Column {
  return {
    id: columna.id,
    boardId: columna.board_id,
    name: columna.name,
    key: columna.key,
    position: columna.position,
    createdAt: new Date(columna.created_at),
    updatedAt: new Date(columna.updated_at),
  };
}

function aTarea(tarea: Tarea): Task {
  return {
    id: tarea.id,
    boardId: tarea.board_id,
    columnId: tarea.column_id,
    title: tarea.title,
    description: tarea.description,
    priority: tarea.priority,
    dueDate: aFechaUtc(tarea.due_date),
    position: tarea.position,
    createdAt: new Date(tarea.created_at),
    updatedAt: new Date(tarea.updated_at),
  };
}
