/**
 * Service entry point. Loads and validates every piece of persistent
 * material before listening; any problem stops the process with a message
 * that names the file or variable to fix. Nothing is generated here.
 */
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { KeyError, loadFederationKey } from "./keys.js";
import { loadSubordinates, SubordinateConfigError } from "./subordinates.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const key = await loadFederationKey(config.signingKeyPath);
  const subordinates = await loadSubordinates(config.subordinatesPath, {
    entityId: config.entityId,
    key,
  });
  const app = await buildApp({ config, key, subordinates }, { logger: true });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    {
      entityId: config.entityId,
      kid: key.kid,
      subordinates: subordinates.filter((entry) => entry.enabled).length,
    },
    "trust anchor ready",
  );
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof KeyError ||
    error instanceof SubordinateConfigError
  ) {
    process.stderr.write(`credimi-federation: ${error.message}\n`);
  } else {
    process.stderr.write("credimi-federation: unexpected startup failure\n");
    console.error(error);
  }
  process.exit(1);
});
