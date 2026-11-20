/**
 * Environment configuration. Every value the service publishes about its own
 * identity derives from FEDERATION_ENTITY_ID; nothing is taken from request
 * headers.
 */

export interface AppConfig {
  /** Normalized Entity Identifier: an https origin without a trailing slash. */
  readonly entityId: string;
  readonly port: number;
  readonly signingKeyPath: string;
  readonly subordinatesPath: string;
  readonly federationName: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_FEDERATION_NAME = "OpenID Federation Trust Anchor";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    entityId: parseEntityId(requireEnv(env, "FEDERATION_ENTITY_ID")),
    port: parsePort(env["PORT"]),
    signingKeyPath: requireEnv(env, "FEDERATION_SIGNING_KEY_PATH"),
    subordinatesPath: requireEnv(env, "FEDERATION_SUBORDINATES_PATH"),
    federationName: optionalEnv(env, "FEDERATION_NAME") ?? DEFAULT_FEDERATION_NAME,
  };
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    throw new ConfigError(`${name} is required but not set.`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Accepts an https URL with a host and no path, query, fragment or
 * credentials (OpenID Federation 1.0 §1.2, §9). A single trailing "/" is
 * removed, as §9 requires before appending the well-known path. Paths are
 * rejected because every route of this service is served from the origin.
 */
export function parseEntityId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`FEDERATION_ENTITY_ID is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("FEDERATION_ENTITY_ID must use the https scheme.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain credentials.");
  }
  if (url.search !== "" || value.includes("?")) {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain a query component.");
  }
  if (url.hash !== "" || value.includes("#")) {
    throw new ConfigError("FEDERATION_ENTITY_ID must not contain a fragment component.");
  }
  if (url.pathname !== "/") {
    throw new ConfigError(
      "FEDERATION_ENTITY_ID must be an origin without a path, for example https://federation.example.org",
    );
  }
  return url.origin;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${value}".`);
  }
  return port;
}
