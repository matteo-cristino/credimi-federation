/**
 * CLI commands. Kept separate from the executable wrapper so tests can run
 * them in-process with their own environment and output streams.
 */
import { ConfigError, loadConfig, requireEnv } from "./config.js";
import { generateFederationKey, KeyError, loadFederationKey, publicJwks } from "./keys.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const BANNER = String.raw`
  ___ ___ ___ ___ ___ __  __ ___
 / __| _ \ __|   \_ _|  \/  |_ _|   credimi-federation
| (__|   / _|| |) | || |\/| || |    OpenID Federation 1.0
 \___|_|_\___|___/___|_|  |_|___|   Trust Anchor
`;

const USAGE = `Usage: credimi-federation <command>

Commands:
  init    Generate the federation signing key at FEDERATION_SIGNING_KEY_PATH.
          Refuses to overwrite an existing key.
  check   Validate the signing key and configuration exactly as startup does.
  jwks    Print the public federation JWK Set (JSON) to standard output.
  help    Show this message.
`;

/** Runs one command and returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  // The banner goes to stderr so `jwks` output stays pipeable JSON.
  io.stderr(BANNER);
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    io.stderr(`Unexpected arguments: ${rest.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case "init": {
        const path = requireEnv(env, "FEDERATION_SIGNING_KEY_PATH");
        const key = await generateFederationKey(path);
        io.stderr(
          `Created ES256 federation signing key\n  path: ${path}\n  kid:  ${key.kid}\n` +
            "Back up this file now; it is the federation's identity.\n",
        );
        return 0;
      }
      case "check": {
        const config = loadConfig(env);
        const key = await loadFederationKey(config.signingKeyPath);
        io.stderr(
          `Configuration is valid\n  entity id: ${config.entityId}\n  kid:       ${key.kid}\n`,
        );
        return 0;
      }
      case "jwks": {
        const key = await loadFederationKey(requireEnv(env, "FEDERATION_SIGNING_KEY_PATH"));
        io.stdout(`${JSON.stringify(publicJwks(key), null, 2)}\n`);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        io.stdout(USAGE);
        return 0;
      default:
        io.stderr(command === undefined ? USAGE : `Unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof KeyError) {
      io.stderr(`Error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
