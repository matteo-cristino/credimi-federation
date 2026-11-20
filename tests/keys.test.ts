import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { generateFederationKey, KeyError, loadFederationKey, publicJwks } from "../src/keys.js";
import { tempDir } from "./helpers.js";

async function writeKeyFile(path: string, content: unknown): Promise<void> {
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), {
    mode: 0o600,
  });
}

describe("generateFederationKey", () => {
  it("writes an ES256 P-256 key whose kid is its RFC 7638 thumbprint", async () => {
    const path = join(await tempDir(), "keys", "federation.jwk");
    const key = await generateFederationKey(path);
    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;

    expect(file).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(file["d"]).toEqual(expect.any(String));
    const thumbprint = await calculateJwkThumbprint(
      { kty: "EC", crv: "P-256", x: file["x"], y: file["y"] },
      "sha256",
    );
    expect(key.kid).toBe(thumbprint);
    expect(file["kid"]).toBe(thumbprint);
  });

  it("creates the key file with mode 0600 in a 0700 directory", async () => {
    const path = join(await tempDir(), "keys", "federation.jwk");
    await generateFederationKey(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  it("refuses to overwrite an existing key and leaves it untouched", async () => {
    const path = join(await tempDir(), "federation.jwk");
    await generateFederationKey(path);
    const before = await readFile(path, "utf8");

    await expect(generateFederationKey(path)).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

describe("loadFederationKey", () => {
  it("loads a generated key with the same kid and public key", async () => {
    const path = join(await tempDir(), "federation.jwk");
    const generated = await generateFederationKey(path);
    const loaded = await loadFederationKey(path);
    expect(loaded.kid).toBe(generated.kid);
    expect(loaded.publicJwk).toEqual(generated.publicJwk);
  });

  it("publishes only public members", async () => {
    const path = join(await tempDir(), "federation.jwk");
    await generateFederationKey(path);
    const key = await loadFederationKey(path);
    const [published] = publicJwks(key).keys;
    expect(Object.keys(published ?? {}).sort()).toEqual(
      ["alg", "crv", "kid", "kty", "use", "x", "y"].sort(),
    );
  });

  it("fails clearly when the file is missing and never creates one", async () => {
    const path = join(await tempDir(), "missing.jwk");
    await expect(loadFederationKey(path)).rejects.toThrow(/not found .*credimi-federation init/);
    await expect(stat(path)).rejects.toThrow(/ENOENT/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a key file readable by group or others",
    async () => {
      const path = join(await tempDir(), "federation.jwk");
      await generateFederationKey(path);
      await chmod(path, 0o644);
      await expect(loadFederationKey(path)).rejects.toThrow(/chmod 600/);
    },
  );

  it("rejects malformed JSON", async () => {
    const path = join(await tempDir(), "federation.jwk");
    await writeKeyFile(path, "{not json");
    await expect(loadFederationKey(path)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a public-only key", async () => {
    const path = join(await tempDir(), "federation.jwk");
    const key = await generateFederationKey(join(await tempDir(), "source.jwk"));
    await writeKeyFile(path, key.publicJwk);
    await expect(loadFederationKey(path)).rejects.toThrow(KeyError);
  });

  it("rejects a key on another curve", async () => {
    const path = join(await tempDir(), "federation.jwk");
    const { privateKey } = await generateKeyPair("ES384", { extractable: true });
    const jwk = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(jwk, "sha256");
    await writeKeyFile(path, { ...jwk, kid, alg: "ES256", use: "sig" });
    await expect(loadFederationKey(path)).rejects.toThrow(/P-256/);
  });

  it("rejects a kid that is not the key's thumbprint", async () => {
    const path = join(await tempDir(), "federation.jwk");
    const key = await generateFederationKey(join(await tempDir(), "source.jwk"));
    await writeKeyFile(path, { ...key.privateJwk, kid: "chosen-by-hand" });
    await expect(loadFederationKey(path)).rejects.toThrow(/thumbprint/);
  });

  it("rejects a private scalar that does not belong to the public key", async () => {
    const path = join(await tempDir(), "federation.jwk");
    const a = await generateFederationKey(join(await tempDir(), "a.jwk"));
    const b = await generateFederationKey(join(await tempDir(), "b.jwk"));
    await writeKeyFile(path, { ...a.privateJwk, d: b.privateJwk.d });
    await expect(loadFederationKey(path)).rejects.toThrow(/do not form a usable ES256 key pair/);
  });
});
