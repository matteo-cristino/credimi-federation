import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { AppConfig } from "../src/config.js";
import { generateFederationKey, type FederationKey } from "../src/keys.js";

export const ENTITY_ID = "https://federation.test.example";
export const ENTITY_STATEMENT_TYPE = "application/entity-statement+jwt";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temporary directory, removed after the current test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "credimi-federation-test-"));
  createdDirs.push(dir);
  return dir;
}

export interface Fixture {
  readonly dir: string;
  readonly config: AppConfig;
  readonly key: FederationKey;
}

/** A Trust Anchor configuration with a freshly generated key on disk. */
export async function createFixture(overrides: Partial<AppConfig> = {}): Promise<Fixture> {
  const dir = await tempDir();
  const config: AppConfig = {
    entityId: ENTITY_ID,
    port: 3000,
    signingKeyPath: join(dir, "keys", "federation.jwk"),
    subordinatesPath: join(dir, "subordinates.json"),
    federationName: "Test Federation",
    ...overrides,
  };
  const key = await generateFederationKey(config.signingKeyPath);
  return { dir, config, key };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
