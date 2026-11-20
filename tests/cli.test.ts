import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNER, runCli } from "../src/commands.js";
import { ENTITY_ID, tempDir } from "./helpers.js";

async function run(argv: string[], env: NodeJS.ProcessEnv) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, env, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr };
}

async function freshEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await tempDir();
  return {
    FEDERATION_ENTITY_ID: ENTITY_ID,
    FEDERATION_SIGNING_KEY_PATH: join(dir, "keys", "federation.jwk"),
    FEDERATION_SUBORDINATES_PATH: join(dir, "subordinates.json"),
  };
}

describe("credimi-federation CLI", () => {
  it("prints its ASCII banner on stderr", async () => {
    const { stderr } = await run(["help"], await freshEnv());
    expect(stderr).toContain(BANNER);
  });

  it("init creates the key once and refuses a second run", async () => {
    const env = await freshEnv();
    const first = await run(["init"], env);
    expect(first.code).toBe(0);
    expect(first.stderr).toMatch(/kid: {2}\S+/);
    const keyFile = await readFile(env["FEDERATION_SIGNING_KEY_PATH"] ?? "", "utf8");

    const second = await run(["init"], env);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/Refusing to overwrite/);
    expect(await readFile(env["FEDERATION_SIGNING_KEY_PATH"] ?? "", "utf8")).toBe(keyFile);
  });

  it("jwks prints only the public JWK Set on stdout", async () => {
    const env = await freshEnv();
    await run(["init"], env);
    const { code, stdout } = await run(["jwks"], env);
    expect(code).toBe(0);
    const jwks = JSON.parse(stdout) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
  });

  it("check fails without a key and names the fix", async () => {
    const { code, stderr } = await run(["check"], await freshEnv());
    expect(code).toBe(1);
    expect(stderr).toMatch(/credimi-federation init/);
  });

  it("rejects unknown commands with usage", async () => {
    const { code, stderr } = await run(["rotate"], await freshEnv());
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown command "rotate"/);
  });
});
