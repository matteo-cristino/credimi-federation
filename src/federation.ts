/**
 * The Trust Anchor itself. Statement building and signing are delegated to
 * @oidfed/authority; this module only wires configuration, the signing key
 * and the advertised endpoints together.
 */
import { MemoryStorageAdapter, TrustAnchor } from "@oidfed/authority";
import {
  createFederationSigningKey,
  MemoryFederationKeyProvider,
  WELL_KNOWN_OPENID_FEDERATION,
  type EntityId,
  type EntityType,
  type JWK,
} from "@oidfed/core";
import type { FederationKey } from "./keys.js";
import type { Subordinate } from "./subordinates.js";

/** Endpoint paths, relative to the Entity Identifier origin. */
export const FederationPath = {
  EntityConfiguration: WELL_KNOWN_OPENID_FEDERATION,
  Fetch: "/federation_fetch",
  List: "/federation_list",
} as const;

export interface FederationEndpoints {
  readonly entityConfiguration: string;
  readonly fetch: string;
  readonly list: string;
}

/** Absolute endpoint URLs, derived only from the configured Entity Identifier. */
export function federationEndpoints(entityId: string): FederationEndpoints {
  return {
    entityConfiguration: new URL(FederationPath.EntityConfiguration, entityId).href,
    fetch: new URL(FederationPath.Fetch, entityId).href,
    list: new URL(FederationPath.List, entityId).href,
  };
}

export interface TrustAnchorOptions {
  readonly entityId: string;
  readonly key: FederationKey;
  readonly subordinates: readonly Subordinate[];
}

export async function createTrustAnchor(options: TrustAnchorOptions): Promise<TrustAnchor> {
  const endpoints = federationEndpoints(options.entityId);
  const keyProvider = new MemoryFederationKeyProvider(
    createFederationSigningKey(options.key.privateJwk as JWK),
  );
  const trustAnchor = new TrustAnchor({
    entityId: options.entityId,
    keyProvider,
    // An in-process index rebuilt from the registry file on every start and
    // never written at runtime; the file is the only source of membership.
    storage: new MemoryStorageAdapter(),
    metadata: {
      federation_entity: {
        federation_fetch_endpoint: endpoints.fetch,
        federation_list_endpoint: endpoints.list,
      },
    },
    // Draft extension; not part of OpenID Federation 1.0. Keep it off so the
    // library does not serve an endpoint this Trust Anchor does not advertise.
    extendedListing: { enabled: false },
  });

  // Disabled entries stay in the registry for visibility but are neither
  // fetchable nor listed.
  for (const subordinate of options.subordinates.filter((entry) => entry.enabled)) {
    await trustAnchor.registerSubordinate({
      entityId: subordinate.entityId as EntityId,
      jwks: { keys: subordinate.jwks.keys.map((key) => ({ ...key })) as JWK[] },
      entityTypes: subordinate.entityTypes as EntityType[],
      ...(subordinate.metadataPolicy === undefined
        ? {}
        : { metadataPolicy: subordinate.metadataPolicy }),
      ...(subordinate.constraints === undefined ? {} : { constraints: subordinate.constraints }),
    });
  }
  return trustAnchor;
}
