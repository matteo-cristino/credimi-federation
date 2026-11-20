import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseSubordinates } from "../src/subordinates.js";
import {
  createFixture,
  ENTITY_ID,
  ENTITY_STATEMENT_TYPE,
  nowSeconds,
  subordinateKey,
} from "./helpers.js";

const ISSUER = "https://capture-wallet.test.example/issuers/eu-pid-device-bound";
const VERIFIER = "https://capture-wallet.test.example/verifier";
const DISABLED = "https://retired.test.example";

const POLICY = { openid_credential_issuer: { credential_issuer: { essential: true } } };
const CONSTRAINTS = { max_path_length: 0 };

async function federation() {
  const { config, key } = await createFixture();
  const issuerKey = await subordinateKey();
  const verifierKey = await subordinateKey("PS256");
  const disabledKey = await subordinateKey();
  const subordinates = await parseSubordinates(
    {
      subordinates: [
        {
          entity_id: ISSUER,
          enabled: true,
          entity_types: ["openid_credential_issuer"],
          jwks: { keys: [issuerKey.publicJwk] },
          metadata_policy: POLICY,
          constraints: CONSTRAINTS,
        },
        {
          entity_id: VERIFIER,
          enabled: true,
          entity_types: ["openid_credential_verifier"],
          jwks: { keys: [verifierKey.publicJwk] },
        },
        {
          entity_id: DISABLED,
          enabled: false,
          entity_types: ["openid_credential_issuer"],
          jwks: { keys: [disabledKey.publicJwk] },
        },
      ],
    },
    { entityId: config.entityId, key },
  );
  const app = await buildApp({ config, key, subordinates });
  const taJwks = createLocalJWKSet({ keys: [{ ...key.publicJwk }] });
  return { app, key, taJwks, issuerKey, verifierKey };
}

function fetchUrl(sub: string): string {
  return `/federation_fetch?sub=${encodeURIComponent(sub)}`;
}

describe("GET /federation_fetch", () => {
  it("returns a Subordinate Statement signed by the Trust Anchor about the pinned keys", async () => {
    const { app, key, taJwks, issuerKey } = await federation();
    const response = await app.inject({ method: "GET", url: fetchUrl(ISSUER) });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(ENTITY_STATEMENT_TYPE);
    expect(decodeProtectedHeader(response.body)).toEqual({
      alg: "ES256",
      typ: "entity-statement+jwt",
      kid: key.kid,
    });
    const { payload } = await jwtVerify(response.body, taJwks, {
      typ: "entity-statement+jwt",
      issuer: ENTITY_ID,
      subject: ISSUER,
      algorithms: ["ES256"],
    });
    const now = nowSeconds();
    expect(payload.iat).toBeLessThanOrEqual(now + 1);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload["jwks"]).toEqual({ keys: [issuerKey.publicJwk] });
    expect(payload["metadata_policy"]).toEqual(POLICY);
    expect(payload["constraints"]).toEqual(CONSTRAINTS);
    // Claims reserved for Entity Configurations never appear in a Subordinate Statement.
    expect(payload).not.toHaveProperty("authority_hints");
    expect(payload).not.toHaveProperty("trust_anchor_hints");
    expect(payload).not.toHaveProperty("trust_marks");
  });

  it("omits metadata_policy and constraints when none are configured", async () => {
    const { app, taJwks, verifierKey } = await federation();
    const response = await app.inject({ method: "GET", url: fetchUrl(VERIFIER) });
    const { payload } = await jwtVerify(response.body, taJwks, { subject: VERIFIER });
    expect(payload["jwks"]).toEqual({ keys: [verifierKey.publicJwk] });
    expect(payload).not.toHaveProperty("metadata_policy");
    expect(payload).not.toHaveProperty("constraints");
    expect(payload).not.toHaveProperty("metadata");
  });

  it.each([
    ["an unknown subordinate", fetchUrl("https://stranger.test.example"), 404, "not_found"],
    ["a disabled subordinate", fetchUrl(DISABLED), 404, "not_found"],
    ["the Trust Anchor itself", fetchUrl(ENTITY_ID), 400, "invalid_request"],
    ["a missing sub", "/federation_fetch", 400, "invalid_request"],
    ["a malformed sub", fetchUrl("not-a-url"), 400, "invalid_request"],
  ])("rejects %s with a §8.9 JSON error", async (_label, url, status, error) => {
    const { app } = await federation();
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      error,
      error_description: expect.any(String) as string,
    });
  });

  it("never exposes the Trust Anchor's private key", async () => {
    const { app, key } = await federation();
    const privateScalar = key.privateJwk.d ?? "";
    for (const url of [fetchUrl(ISSUER), fetchUrl(VERIFIER), "/federation_list"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body).not.toContain(privateScalar);
      if (url.startsWith("/federation_fetch")) {
        expect(JSON.stringify(decodeJwt(body))).not.toContain('"d":');
      }
    }
  });
});

describe("GET /federation_list", () => {
  it("lists enabled subordinates as a JSON array", async () => {
    const { app } = await federation();
    const response = await app.inject({ method: "GET", url: "/federation_list" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json<string[]>().sort()).toEqual([ISSUER, VERIFIER].sort());
  });

  it("filters by entity_type", async () => {
    const { app } = await federation();
    const issuers = await app.inject({
      method: "GET",
      url: "/federation_list?entity_type=openid_credential_issuer",
    });
    expect(issuers.json()).toEqual([ISSUER]);
    const providers = await app.inject({
      method: "GET",
      url: "/federation_list?entity_type=openid_provider",
    });
    expect(providers.json()).toEqual([]);
  });

  it("matches any of several entity_type values", async () => {
    const { app } = await federation();
    const response = await app.inject({
      method: "GET",
      url: "/federation_list?entity_type=openid_credential_issuer&entity_type=openid_credential_verifier",
    });
    expect(response.json<string[]>().sort()).toEqual([ISSUER, VERIFIER].sort());
  });

  it("rejects entity_type values the library does not know", async () => {
    const { app } = await federation();
    const response = await app.inject({
      method: "GET",
      url: "/federation_list?entity_type=openid_credential_verifier_provider",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("filters by intermediate, which no subordinate is", async () => {
    const { app } = await federation();
    const response = await app.inject({ method: "GET", url: "/federation_list?intermediate=true" });
    expect(response.json()).toEqual([]);
  });

  it.each(["trust_marked=true", "trust_mark_type=https://marks.test.example/x"])(
    "answers %s with unsupported_parameter",
    async (query) => {
      const { app } = await federation();
      const response = await app.inject({ method: "GET", url: `/federation_list?${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.json()).toMatchObject({ error: "unsupported_parameter" });
    },
  );
});
