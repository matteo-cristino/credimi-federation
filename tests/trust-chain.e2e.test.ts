/**
 * End-to-end Trust Chain test: a locally generated subordinate publishes its
 * own Entity Configuration, the operator pins its public key in the registry,
 * and three verifiers assemble and check the chain up to the Trust Anchor:
 *
 * 1. @openid-federation/core (OpenWallet Foundation Labs) resolves the chain.
 *    It shares no code with @oidfed, which signs the statements.
 * 2. A direct OpenID Federation 1.0 §10.2 validation written with `jose` only,
 *    anchored in the Trust Anchor key obtained out of band.
 * 3. @oidfed/core validateTrustChain with the same pinned Trust Anchor key.
 */
import {
  createTrustAnchorSet,
  resolveTrustChains as oidfedResolveTrustChains,
  validateTrustChain,
  type EntityId,
  type JWK as OidfedJwk,
} from "@oidfed/core";
import { resolveTrustChains as owfResolveTrustChains } from "@openid-federation/core";
import type { FastifyInstance } from "fastify";
import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { publicJwks } from "../src/keys.js";
import { parseSubordinates } from "../src/subordinates.js";
import {
  createFixture,
  ENTITY_ID,
  nowSeconds,
  subordinateKey,
  type SubordinateKey,
} from "./helpers.js";

const LEAF = "https://capture-wallet.test.example/issuers/eu-pid-device-bound";
const ENTITY_STATEMENT = "application/entity-statement+jwt";
const POLICY = { openid_credential_issuer: { display: { default: [{ name: "Test issuer" }] } } };
const LEAF_METADATA = {
  openid_credential_issuer: {
    credential_issuer: LEAF,
    credential_endpoint: `${LEAF}/credential`,
    credential_configurations_supported: {},
    // Not required by OpenID Federation 1.0; @openid-federation/core 0.2.1
    // rejects issuer metadata without it.
    client_registration_types_supported: ["automatic"],
  },
};

/** The subordinate's own Entity Configuration, signed with its own key. */
async function leafEntityConfiguration(signingKey: SubordinateKey, published: JWK[]) {
  const now = nowSeconds();
  return new SignJWT({
    iss: LEAF,
    sub: LEAF,
    iat: now,
    exp: now + 3600,
    jwks: { keys: published },
    authority_hints: [ENTITY_ID],
    metadata: LEAF_METADATA,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "entity-statement+jwt",
      kid: signingKey.publicJwk.kid ?? "",
    })
    .sign(signingKey.privateKey);
}

interface Federation {
  readonly app: FastifyInstance;
  /** The Trust Anchor JWK Set as distributed out of band (`credimi-federation jwks`). */
  readonly pinnedTrustAnchorJwks: { keys: JWK[] };
  readonly fetch: typeof fetch;
}

/**
 * Trust Anchor app plus a subordinate web server, both reachable through one
 * fetch function keyed by origin, so no network or TLS is involved.
 */
async function federation(options: {
  registeredKey: SubordinateKey;
  leafSigningKey: SubordinateKey;
  enabled?: boolean;
  registered?: boolean;
}): Promise<Federation> {
  const { config, key } = await createFixture();
  const subordinates = await parseSubordinates(
    {
      subordinates:
        options.registered === false
          ? []
          : [
              {
                entity_id: LEAF,
                enabled: options.enabled ?? true,
                entity_types: ["openid_credential_issuer"],
                jwks: { keys: [options.registeredKey.publicJwk] },
                metadata_policy: POLICY,
                constraints: { max_path_length: 0 },
              },
            ],
    },
    { entityId: config.entityId, key },
  );
  const app = await buildApp({ config, key, subordinates });
  const leafJwt = await leafEntityConfiguration(options.leafSigningKey, [
    options.leafSigningKey.publicJwk,
  ]);

  const fetchStub = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === ENTITY_ID) {
      const response = await app.inject({ method: "GET", url: url.pathname + url.search });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": String(response.headers["content-type"]) },
      });
    }
    if (`${url.origin}${url.pathname}` === `${LEAF}/.well-known/openid-federation`) {
      return new Response(leafJwt, { headers: { "content-type": ENTITY_STATEMENT } });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    app,
    pinnedTrustAnchorJwks: publicJwks(key),
    fetch: fetchStub,
  };
}

/** OWF verify callback implemented with jose: checks one JWS signature. */
async function verifyWithJose(options: {
  jwt: string;
  jwk: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const alg = typeof options.jwk["alg"] === "string" ? options.jwk["alg"] : "ES256";
    await compactVerify(options.jwt, await importJWK(options.jwk as JWK, alg));
    return true;
  } catch {
    return false;
  }
}

const FederationEntityClaims = z.object({
  metadata: z.object({
    federation_entity: z.object({ federation_fetch_endpoint: z.url() }),
  }),
});

/** Fetches the three statements of a TA → leaf chain the way a relying party would. */
async function collectChain(fetchImpl: typeof fetch): Promise<string[]> {
  const leafEc = await (await fetchImpl(`${LEAF}/.well-known/openid-federation`)).text();
  const taEc = await (await fetchImpl(`${ENTITY_ID}/.well-known/openid-federation`)).text();
  const fetchEndpoint = FederationEntityClaims.parse(decodeJwt(taEc)).metadata.federation_entity
    .federation_fetch_endpoint;
  const statement = await fetchImpl(`${fetchEndpoint}?sub=${encodeURIComponent(LEAF)}`);
  expect(statement.status).toBe(200);
  return [leafEc, await statement.text(), taEc];
}

/**
 * OpenID Federation 1.0 §10.2 validation using only jose. ES[0] is the leaf
 * Entity Configuration, ES[1] the Trust Anchor's statement about the leaf,
 * ES[2] the Trust Anchor's Entity Configuration.
 */
async function validateWithJose(chain: string[], pinnedTrustAnchorJwks: { keys: JWK[] }) {
  const [leafEc, subordinateStatement, taEc] = chain;
  const typ = "entity-statement+jwt";
  // ES[2]: anchored in the out-of-band key, not in whatever the endpoint serves.
  const ta = await jwtVerify(taEc ?? "", createLocalJWKSet(pinnedTrustAnchorJwks), {
    typ,
    issuer: ENTITY_ID,
    subject: ENTITY_ID,
  });
  // ES[1]: issued by the Trust Anchor about the leaf, verified with ES[2].jwks.
  const statement = await jwtVerify(
    subordinateStatement ?? "",
    createLocalJWKSet(ta.payload["jwks"] as { keys: JWK[] }),
    { typ, issuer: ENTITY_ID, subject: LEAF },
  );
  // ES[0]: must verify with the keys the Trust Anchor pinned in ES[1].jwks.
  const leaf = await jwtVerify(
    leafEc ?? "",
    createLocalJWKSet(statement.payload["jwks"] as { keys: JWK[] }),
    { typ, issuer: LEAF, subject: LEAF },
  );
  expect(leaf.payload["authority_hints"]).toContain(ENTITY_ID);
  return { ta, statement, leaf };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Trust Chain from a pinned subordinate to the Trust Anchor", () => {
  it("is assembled and verified by an independent implementation", async () => {
    const leafKey = await subordinateKey();
    const { fetch: fetchStub, pinnedTrustAnchorJwks } = await federation({
      registeredKey: leafKey,
      leafSigningKey: leafKey,
    });
    // @openid-federation/core 0.2.1 always uses the global fetch.
    vi.stubGlobal("fetch", fetchStub);

    const chains = await owfResolveTrustChains({
      entityId: LEAF,
      trustAnchorEntityIds: [ENTITY_ID],
      verifyJwtCallback: verifyWithJose,
    });

    expect(chains).toHaveLength(1);
    const [chain] = chains;
    // OWF returns the leaf Entity Configuration separately and the chain from
    // the superior's statement about the leaf up to the Trust Anchor.
    expect(chain?.rawLeafEntityConfiguration.sub).toBe(LEAF);
    expect(chain?.rawLeafEntityConfiguration.authority_hints).toEqual([ENTITY_ID]);
    expect(chain?.chain.map((statement) => [statement.iss, statement.sub])).toEqual([
      [ENTITY_ID, LEAF],
      [ENTITY_ID, ENTITY_ID],
    ]);
    expect(chain?.trustAnchorEntityConfiguration.sub).toBe(ENTITY_ID);
    // The resolver trusts Trust Anchors by identifier only, so check its key
    // against the one distributed out of band.
    expect(chain?.trustAnchorEntityConfiguration.jwks.keys).toEqual(pinnedTrustAnchorJwks.keys);
    expect(chain?.chain[0]?.jwks.keys).toEqual([leafKey.publicJwk]);
  });

  it("validates link by link with jose against the pinned Trust Anchor key", async () => {
    const leafKey = await subordinateKey();
    const { fetch: fetchStub, pinnedTrustAnchorJwks } = await federation({
      registeredKey: leafKey,
      leafSigningKey: leafKey,
    });
    const { statement, leaf } = await validateWithJose(
      await collectChain(fetchStub),
      pinnedTrustAnchorJwks,
    );
    expect(statement.payload["metadata_policy"]).toEqual(POLICY);
    expect(statement.payload["constraints"]).toEqual({ max_path_length: 0 });
    expect(leaf.payload["metadata"]).toEqual(LEAF_METADATA);
  });

  it("passes full OpenID Federation 1.0 validation, applying the configured policy", async () => {
    const leafKey = await subordinateKey();
    const { fetch: fetchStub, pinnedTrustAnchorJwks } = await federation({
      registeredKey: leafKey,
      leafSigningKey: leafKey,
    });
    const anchors = createTrustAnchorSet([
      { entityId: ENTITY_ID, jwks: pinnedTrustAnchorJwks as { keys: OidfedJwk[] } },
    ]);
    const resolved = await oidfedResolveTrustChains(LEAF as EntityId, anchors, {
      httpClient: fetchStub,
    });
    expect(resolved.errors).toEqual([]);
    expect(resolved.chains).toHaveLength(1);

    const result = await validateTrustChain(resolved.chains[0]?.statements ?? [], anchors, {
      httpClient: fetchStub,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.chain?.trustAnchorId).toBe(ENTITY_ID);
    expect(result.chain?.resolvedMetadata["openid_credential_issuer"]?.["display"]).toEqual([
      { name: "Test issuer" },
    ]);
  });

  it("rejects a reachable, self-signed Entity Configuration whose key was not pinned", async () => {
    const pinned = await subordinateKey();
    const impostor = await subordinateKey();
    const { fetch: fetchStub, pinnedTrustAnchorJwks } = await federation({
      registeredKey: pinned,
      leafSigningKey: impostor,
    });
    const chain = await collectChain(fetchStub);

    await expect(validateWithJose(chain, pinnedTrustAnchorJwks)).rejects.toThrow();
    const anchors = createTrustAnchorSet([
      { entityId: ENTITY_ID, jwks: pinnedTrustAnchorJwks as { keys: OidfedJwk[] } },
    ]);
    const result = await validateTrustChain(chain, anchors, { httpClient: fetchStub });
    expect(result.valid).toBe(false);
  });

  it.each([
    ["not registered", { registered: false }],
    ["disabled", { enabled: false }],
  ])("yields no chain for a subordinate that is %s", async (_label, overrides) => {
    const leafKey = await subordinateKey();
    const { fetch: fetchStub, pinnedTrustAnchorJwks } = await federation({
      registeredKey: leafKey,
      leafSigningKey: leafKey,
      ...overrides,
    });
    const anchors = createTrustAnchorSet([
      { entityId: ENTITY_ID, jwks: pinnedTrustAnchorJwks as { keys: OidfedJwk[] } },
    ]);
    const resolved = await oidfedResolveTrustChains(LEAF as EntityId, anchors, {
      httpClient: fetchStub,
    });
    expect(resolved.chains).toEqual([]);

    // OWF rejects when the fetch endpoint answers not_found; either way no
    // chain is established.
    vi.stubGlobal("fetch", fetchStub);
    const owfChains = await owfResolveTrustChains({
      entityId: LEAF,
      trustAnchorEntityIds: [ENTITY_ID],
      verifyJwtCallback: verifyWithJose,
    }).catch(() => []);
    expect(owfChains).toEqual([]);
  });
});
