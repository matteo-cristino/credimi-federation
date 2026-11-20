import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadFederationKey } from "../src/keys.js";
import { createFixture, ENTITY_ID, ENTITY_STATEMENT_TYPE, nowSeconds } from "./helpers.js";

const WELL_KNOWN = "/.well-known/openid-federation";

describe("GET /.well-known/openid-federation", () => {
  it("returns the Entity Configuration with the entity-statement media type", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const response = await app.inject({ method: "GET", url: WELL_KNOWN });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(ENTITY_STATEMENT_TYPE);
    expect(response.body.split(".")).toHaveLength(3);
  });

  it("is an explicitly typed, self-signed statement about the Trust Anchor", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const jwt = (await app.inject({ method: "GET", url: WELL_KNOWN })).body;

    expect(decodeProtectedHeader(jwt)).toEqual({
      alg: "ES256",
      typ: "entity-statement+jwt",
      kid: key.kid,
    });

    // Verify with the key published inside the statement itself (self-signed)…
    const claims = decodeJwt(jwt);
    const embedded = createLocalJWKSet(claims["jwks"] as { keys: JWK[] });
    const { payload } = await jwtVerify(jwt, embedded, {
      typ: "entity-statement+jwt",
      issuer: ENTITY_ID,
      subject: ENTITY_ID,
      algorithms: ["ES256"],
    });
    // …and with the key the operator holds on disk.
    await jwtVerify(jwt, createLocalJWKSet({ keys: [{ ...key.publicJwk }] }), {
      typ: "entity-statement+jwt",
    });

    const now = nowSeconds();
    expect(payload.iat).toBeLessThanOrEqual(now + 1);
    expect(payload.exp).toBeGreaterThan(now);
    expect(payload.exp).toBeGreaterThan(payload.iat ?? Number.POSITIVE_INFINITY);
    expect(payload).not.toHaveProperty("authority_hints");
    expect(payload).not.toHaveProperty("trust_anchor_hints");
    expect(payload["jwks"]).toEqual({ keys: [key.publicJwk] });
    expect(payload["metadata"]).toEqual({
      federation_entity: {
        federation_fetch_endpoint: `${ENTITY_ID}/federation_fetch`,
        federation_list_endpoint: `${ENTITY_ID}/federation_list`,
      },
    });
  });

  it("never exposes the private key", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const privateScalar = key.privateJwk.d ?? "";
    expect(privateScalar).not.toBe("");

    for (const url of [WELL_KNOWN, "/healthz"]) {
      const response = await app.inject({ method: "GET", url });
      const body = response.body;
      expect(body).not.toContain(privateScalar);
      if (url === WELL_KNOWN) {
        const decoded = JSON.stringify(decodeJwt(body));
        expect(decoded).not.toContain(privateScalar);
        expect(decoded).not.toContain('"d":');
      }
    }
  });

  it("derives identity from configuration, not from Host or forwarding headers", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const response = await app.inject({
      method: "GET",
      url: WELL_KNOWN,
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    });
    const payload = decodeJwt(response.body);
    expect(payload.iss).toBe(ENTITY_ID);
    expect(JSON.stringify(payload)).not.toContain("attacker.example");
  });

  it("stays verifiable across restarts because the key is reloaded, not regenerated", async () => {
    const { config, key } = await createFixture();
    const before = await buildApp({ config, key, subordinates: [] });
    const firstJwt = (await before.inject({ method: "GET", url: WELL_KNOWN })).body;
    await before.close();

    const reloaded = await loadFederationKey(config.signingKeyPath);
    const after = await buildApp({ config, key: reloaded, subordinates: [] });
    const secondJwt = (await after.inject({ method: "GET", url: WELL_KNOWN })).body;

    expect(decodeProtectedHeader(secondJwt).kid).toBe(decodeProtectedHeader(firstJwt).kid);
    expect(decodeJwt(secondJwt)["jwks"]).toEqual(decodeJwt(firstJwt)["jwks"]);
    // A statement signed before the restart verifies with keys published after it.
    const publishedAfter = createLocalJWKSet(decodeJwt(secondJwt)["jwks"] as { keys: JWK[] });
    await expect(jwtVerify(firstJwt, publishedAfter)).resolves.toBeDefined();
  });
});

describe("federation endpoint methods and unknown paths", () => {
  it("answers HEAD like GET without a body", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const response = await app.inject({ method: "HEAD", url: WELL_KNOWN });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(ENTITY_STATEMENT_TYPE);
    expect(response.body).toBe("");
  });

  it("rejects other methods with a §8.9 error body", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const response = await app.inject({ method: "POST", url: WELL_KNOWN, payload: "x=1" });
    expect(response.statusCode).toBe(405);
    expect(response.headers["allow"]).toBe("GET, HEAD");
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      error: "invalid_request",
      error_description: expect.any(String) as string,
    });
  });

  it.each(["/federation_resolve?sub=x", "/federation_historical_keys", "/nope"])(
    "returns not_found for %s, which is not advertised",
    async (url) => {
      const { config, key } = await createFixture();
      const app = await buildApp({ config, key, subordinates: [] });
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.json()).toMatchObject({ error: "not_found" });
    },
  );
});

describe("GET /healthz", () => {
  it("reports ok as uncached JSON", async () => {
    const { config, key } = await createFixture();
    const app = await buildApp({ config, key, subordinates: [] });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ status: "ok" });
  });
});
