/**
 * The OpenAPI description. openapi/openapi.yaml is the single source; the
 * JSON form is derived from it at startup, and the server list is completed
 * from configuration rather than from request headers.
 */
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";

export interface OpenApiDocuments {
  readonly yaml: string;
  readonly json: string;
}

const SOURCE = new URL("../openapi/openapi.yaml", import.meta.url);

export async function loadOpenApi(entityId: string): Promise<OpenApiDocuments> {
  const document = parse(await readFile(SOURCE, "utf8")) as Record<string, unknown>;
  document["servers"] = [
    { url: "/", description: "This deployment (same origin)" },
    { url: entityId, description: "Configured Entity Identifier" },
  ];
  return { yaml: stringify(document), json: `${JSON.stringify(document, null, 2)}\n` };
}
