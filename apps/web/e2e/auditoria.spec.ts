import { auditoriaDe, idDeTarea, tareaEntera } from "./base";
import { TITULO_VENCIDA_FUERA } from "./semilla";
import { esperandoAlServidor, expect, panel, tarjeta, test } from "./tablero";

/**
 * CT-10 de la 10.2: "una operacion destructiva deja un registro en audit_log
 * con before_data completo", con la forma de la 7.4 para un DELETE —la entidad
 * entera antes, nada despues— y el actor USER que la 7.4 le da a la UI web.
 *
 * El contrato REST ya lo cubre (`tasks-id.test.ts`, "trae la tarea ENTERA en
 * before_data"); esto lo cubre donde la 10.2 pone los CT, desde la pantalla. Y
 * "completo" significa LO MISMO en los dos niveles: los diez campos que arma
 * `tareaCompleta`, en snake_case, con `due_date` como AAAA-MM-DD y los dos
 * instantes en ISO, comparados con igualdad EXACTA. Un campo de mas o de menos
 * no pasa.
 *
 * LO ESPERADO SALE DE LA BASE, leido ANTES de borrar, y no de la semilla: la
 * semilla no fija ids ni instantes, y lo que el registro tiene que reproducir es
 * la fila tal como estaba.
 *
 * LA TAREA es la unica de la semilla con TODOS los campos opcionales con valor
 * —descripcion y fecha limite—: con alguno en null, un registro que perdiera
 * ese campo y lo reemplazara por null pasaria igual. La prueba lo afirma antes
 * de borrar, para caer si la semilla cambia.
 *
 * Se lee la base recien despues de `esperandoAlServidor`: cuando llega la
 * respuesta de la Server Action, la transaccion ya commiteo, borrado y registro
 * juntos (el registro va dentro de la transaccion del borrado, 7.4).
 *
 * LO QUE NO AFIRMA: el `request_id` y el `actor_name` del registro. Hay deuda
 * anotada sobre el requestId de un borrado desde el panel, y esta prueba no la
 * resuelve.
 */

test.beforeEach(async ({ page, sembrado }) => {
  void sembrado;
  await page.goto("/");
});

test("CT-10: borrar una tarea desde el panel deja un DELETE con la tarea entera en before_data", async ({
  page,
}) => {
  const id = await idDeTarea(TITULO_VENCIDA_FUERA);
  const antes = await tareaEntera(id);

  if (antes === undefined) {
    throw new Error(`La tarea sembrada "${TITULO_VENCIDA_FUERA}" no esta en la base.`);
  }

  // Todos los opcionales con valor: ver la cabecera.
  expect(antes.description).not.toBeNull();
  expect(antes.due_date).not.toBeNull();

  await tarjeta(page, TITULO_VENCIDA_FUERA).click();
  await panel(page).getByRole("button", { name: "Borrar tarea" }).click();
  await esperandoAlServidor(page, () =>
    panel(page).getByRole("button", { name: "Si, borrar" }).click(),
  );

  // La tarea ya no existe.
  expect(await tareaEntera(id)).toBeUndefined();

  // Exactamente UN registro DELETE para ella.
  const registros = await auditoriaDe("DELETE", id);
  expect(registros).toHaveLength(1);

  const [registro] = registros;
  expect(registro).toMatchObject({ entity_type: "task", actor_type: "USER" });
  expect(registro?.after_data).toBeNull();

  // Completo, con el criterio del contrato REST: igualdad exacta.
  expect(registro?.before_data).toEqual({
    ...antes,
    created_at: antes.created_at.toISOString(),
    updated_at: antes.updated_at.toISOString(),
  });
});
