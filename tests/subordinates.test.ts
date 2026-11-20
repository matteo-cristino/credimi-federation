import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  loadSubordinates,
  parseSubordinates,
  SubordinateConfigError,
  type RegistryOwner,
} from "../src/subordinates.js";
import { createFixture, ENTITY_ID, subordinateKey, tempDir } from "./helpers.js";

const ISSUER = "https://capture-wallet.test.example/issuers/eu-pid-device-bound";
const VERIFIER = "https://capture-wallet.test.example/verifier";

async function owner(): Promise<RegistryOwner> {
  const { config, key } = await createFixture();
  return { entityId: config.entityId, key };
}

async function entry(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    entity_id: ISSUER,
    enabled: true,
    entity_types: ["openid_credential_issuer"],
    jwks: { keys: [(await subordinateKey()).publicJwk] },
    ...overrides,
  };
}

/** Collects the issue list of a rejected registry. */
async function issuesOf(subordinates: unknown[], registryOwner?: RegistryOwner): Promise<string> {
  try {
    await parseSubordinates({ subordinates }, registryOwner ?? (await owner()));
  } catch (error) {
    expect(error).toBeInstanceOf(SubordinateConfigError);
    return (error as SubordinateConfigError).issues.join("\n");
  }
  throw new Error("expected the registry to be rejected");
}

describe("parseSubordinates", () => {
  it("accepts a valid registry, keeping disabled entries", async () => {
    const issuerKey = await subordinateKey();
    const verifierKey = await subordinateKey("PS256");
    const result = await parseSubordinates(
      {
        subordinates: [
          {
            entity_id: ISSUER,
            enabled: true,
            entity_types: ["openid_credential_issuer"],
            jwks: { keys: [issuerKey.publicJwk] },
            metadata_policy: {
              openid_credential_issuer: { display: { essential: true } },
            },
            constraints: { max_path_length: 0, allowed_entity_types: ["openid_credential_issuer"] },
          },
          {
            entity_id: VERIFIER,
            enabled: false,
            jwks: { keys: [verifierKey.publicJwk] },
          },
        ],
      },
      await owner(),
    );

    expect(result).toEqual([
      {
        entityId: ISSUER,
        enabled: true,
        entityTypes: ["openid_credential_issuer"],
        jwks: { keys: [issuerKey.publicJwk] },
        metadataPolicy: { openid_credential_issuer: { display: { essential: true } } },
        constraints: { max_path_length: 0, allowed_entity_types: ["openid_credential_issuer"] },
      },
      {
        entityId: VERIFIER,
        enabled: false,
        entityTypes: [],
        jwks: { keys: [verifierKey.publicJwk] },
      },
    ]);
  });

  it("accepts an empty registry", async () => {
    await expect(parseSubordinates({ subordinates: [] }, await owner())).resolves.toEqual([]);
  });

  it("rejects duplicate registrations, including a trailing-slash variant", async () => {
    const issues = await issuesOf([
      await entry(),
      await entry({ entity_id: `${ISSUER}/` }),
      await entry(),
    ]);
    expect(issues).toMatch(/subordinates\[1\]\.entity_id .* duplicates subordinates\[0\]/);
    expect(issues).toMatch(/subordinates\[2\]\.entity_id .* duplicates subordinates\[0\]/);
  });

  it("rejects registering the Trust Anchor under itself", async () => {
    expect(await issuesOf([await entry({ entity_id: ENTITY_ID })])).toMatch(/its own subordinate/);
  });

  it.each([
    ["http://insecure.test.example"],
    ["https://issuer.test.example/?q=1"],
    ["https://issuer.test.example/#f"],
    ["not a url"],
  ])("rejects the malformed entity identifier %s", async (entityId) => {
    expect(await issuesOf([await entry({ entity_id: entityId })])).toMatch(/entity_id/);
  });

  it("rejects private key material and names the key", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = { ...(await exportJWK(privateKey)), kid: "leaked" };
    const issues = await issuesOf([await entry({ jwks: { keys: [privateJwk] } })]);
    expect(issues).toMatch(
      /subordinates\[0\]\.jwks\.keys\[0\] contains private key material \(d\)/,
    );
  });

  it("rejects the Trust Anchor's own key as a subordinate key", async () => {
    const registryOwner = await owner();
    const issues = await issuesOf(
      [await entry({ jwks: { keys: [{ ...registryOwner.key.publicJwk }] } })],
      registryOwner,
    );
    expect(issues).toMatch(/Trust Anchor's own federation key/);
  });

  it.each([
    [
      "a key without kid",
      /keys\[0\]: .*kid/s,
      async () => ({ ...(await subordinateKey()).publicJwk, kid: undefined }),
    ],
    [
      "an alg that does not match the curve",
      /alg ES384 does not match curve P-256/,
      async () => ({ ...(await subordinateKey()).publicJwk, alg: "ES384" }),
    ],
    [
      "a point that is not on the curve",
      /not a valid public key/,
      async () => ({ ...(await subordinateKey()).publicJwk, x: "AAAA" }),
    ],
    [
      "an unsupported key type",
      /kty OKP is not supported/,
      async () => ({ ...(await exportJWK((await generateKeyPair("EdDSA")).publicKey)), kid: "k" }),
    ],
    [
      "an RSA key shorter than 2048 bits",
      /RSA modulus must be at least 2048 bits/,
      () => ({
        ...generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }),
        kid: "short",
      }),
    ],
    [
      "an encryption key",
      /keys\[0\]: .*use/s,
      async () => ({ ...(await subordinateKey()).publicJwk, use: "enc" }),
    ],
  ])("rejects %s", async (_label, reason, makeKey) => {
    const issues = await issuesOf([await entry({ jwks: { keys: [await makeKey()] } })]);
    expect(issues).toMatch(/subordinates\[0\]\.jwks\.keys\[0\]/);
    expect(issues).toMatch(reason);
  });

  it("rejects duplicate kids and an empty JWK Set", async () => {
    const key = (await subordinateKey()).publicJwk;
    const other = { ...(await subordinateKey()).publicJwk, kid: key.kid };
    expect(await issuesOf([await entry({ jwks: { keys: [key, other] } })])).toMatch(
      /kid ".*" is not unique/,
    );
    expect(await issuesOf([await entry({ jwks: { keys: [] } })])).toMatch(/at least one key/);
  });

  it("rejects unknown members so typos cannot silently drop settings", async () => {
    const issues = await issuesOf([await entry({ metadataPolicy: {} })]);
    expect(issues).toMatch(/metadataPolicy/);
  });

  it("rejects non-standard and incompatible metadata policy operators", async () => {
    const custom = await issuesOf([
      await entry({ metadata_policy: { openid_credential_issuer: { a: { regexp: "x" } } } }),
    ]);
    expect(custom).toMatch(/operator "regexp" is not a standard/);

    const incompatible = await issuesOf([
      await entry({
        metadata_policy: { openid_credential_issuer: { a: { add: ["x"], one_of: ["x", "y"] } } },
      }),
    ]);
    expect(incompatible).toMatch(/metadata_policy/);
  });

  it("rejects unknown or malformed constraints", async () => {
    expect(await issuesOf([await entry({ constraints: { max_depth: 1 } })])).toMatch(
      /unsupported member\(s\) max_depth/,
    );
    expect(await issuesOf([await entry({ constraints: { max_path_length: -1 } })])).toMatch(
      /constraints/,
    );
  });

  it("reports every problem in one error", async () => {
    const issues = await issuesOf([
      await entry({ entity_id: "http://a.test.example" }),
      await entry({ entity_id: "https://b.test.example", enabled: "yes" }),
    ]);
    expect(issues).toMatch(/subordinates\[0\]/);
    expect(issues).toMatch(/subordinates\[1\]/);
  });
});

describe("loadSubordinates", () => {
  it("fails clearly when the file is missing", async () => {
    const path = join(await tempDir(), "subordinates.json");
    await expect(loadSubordinates(path, await owner())).rejects.toThrow(
      /file not found.*"subordinates": \[\]/,
    );
  });

  it("rejects invalid JSON and a wrong top-level shape", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "array.json"), "[]");
    await expect(loadSubordinates(join(dir, "broken.json"), await owner())).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(loadSubordinates(join(dir, "array.json"), await owner())).rejects.toThrow(
      /must be \{"subordinates": \[\.\.\.\]\}/,
    );
  });
});

describe("config/subordinates.example.json", () => {
  it("is a valid registry, so the documented example can be copied as-is", async () => {
    const subordinates = await loadSubordinates("config/subordinates.example.json", await owner());
    expect(subordinates.map((s) => [s.entityId, s.enabled])).toEqual([
      ["https://issuer.example.org", true],
      ["https://verifier.example.org", false],
    ]);
  });
});
