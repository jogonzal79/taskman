import { conAuthMcp } from "../../lib/auth";
import { atenderMcp } from "../../lib/mcp";

/**
 * /mcp (8.1): el servidor MCP por Streamable HTTP, para clientes remotos.
 *
 * Fuera de /api porque no es un endpoint REST de la 6.2: es un transporte del
 * protocolo MCP. Pero autentica IGUAL que /api —la misma clave Bearer, el mismo
 * `ApiKeyService`, el mismo 401— y aplica los mismos scopes, que es lo que la 8.1
 * exige. `conAuthMcp` y no `conAuth` porque aca el scope no es uno por endpoint
 * sino uno por herramienta (ver `lib/auth.ts`).
 *
 * Los tres verbos pasan por la autenticacion: un GET o un DELETE sin clave es un
 * 401 como cualquier otro, y con clave un 405 (ver `atenderMcp`).
 */

export const dynamic = "force-dynamic";

export const POST = conAuthMcp(atenderMcp);
export const GET = conAuthMcp(atenderMcp);
export const DELETE = conAuthMcp(atenderMcp);
