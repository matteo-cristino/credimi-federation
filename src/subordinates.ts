/**
 * Declarative subordinate registry.
 *
 * Membership is a JSON file maintained by the federation operator. Each entry
 * pins the subordinate's public federation keys; the Trust Anchor never
 * fetches a subordinate's Entity Configuration to learn its keys, so being
 * reachable on the network grants nothing. The whole file is validated before
 * the service starts; one bad entry stops startup.
 */
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FederationMetadataPolicySchema,
  PolicyOperator,
  resolveMetadataPolicy,
  TrustChainConstraintsSchema,
  validateEntityId,
  type EntityStatementPayload,
} from "@oidfed/core";
import { calculateJwkThumbprint, type JWK } from "jose";
import { z } from "zod";
import type { FederationKey } from "./keys.js";

export interface Subordinate {
  readonly entityId: string;
  readonly enabled: boolean;
  readonly entityTypes: readonly string[];
  readonly jwks: { readonly keys: readonly JWK[] };
  readonly metadataPolicy?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly constraints?: Readonly<Record<string, unknown>>;
}

export class SubordinateConfigError extends Error {
  override readonly name = "SubordinateConfigError";
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid subordinate registry ${path}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/** Identity of the Trust Anchor the registry is validated against. */
export interface RegistryOwner {
  readonly entityId: string;
  readonly key: FederationKey;
}

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
const EC_CURVE_ALGORITHMS: Readonly<Record<string, string>> = {
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};
const RSA_ALGORITHMS: Readonly<Record<string, true>> = {
  PS256: true,
  PS384: true,
  PS512: true,
  RS256: true,
};
const MIN_RSA_MODULUS_BITS = 2048;
const STANDARD_POLICY_OPERATORS: Readonly<Record<string, true>> = Object.fromEntries(
  Object.values(PolicyOperator).map((operator) => [operator, true]),
);
const CONSTRAINT_MEMBERS: Readonly<Record<string, true>> = {
  max_path_length: true,
  naming_constraints: true,
  allowed_entity_types: true,
};
const NAMING_CONSTRAINT_MEMBERS: Readonly<Record<string, true>> = {
  permitted: true,
  excluded: true,
};

const PublicJwkSchema = z.strictObject({
  kty: z.string(),
  kid: z.string().min(1),
  use: z.literal("sig").optional(),
  alg: z.string().optional(),
  key_ops: z.array(z.literal("verify")).optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
});

const SubordinateEntrySchema = z.strictObject({
  entity_id: z.string(),
  enabled: z.boolean(),
  entity_types: z.array(z.string().regex(/^\S+$/, "must be a non-empty identifier")).default([]),
  jwks: z.strictObject({ keys: z.array(z.unknown()).min(1, "must contain at least one key") }),
  metadata_policy: z.record(z.string(), z.unknown()).optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
});

const RegistryFileSchema = z.strictObject({
  subordinates: z.array(z.unknown()),
});

/** Reads and validates the registry file. Throws SubordinateConfigError. */
export async function loadSubordinates(path: string, owner: RegistryOwner): Promise<Subordinate[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new SubordinateConfigError(path, [
        'file not found. Create it; an empty registry is {"subordinates": []} ' +
          "(see config/subordinates.example.json).",
      ]);
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SubordinateConfigError(path, ["file is not valid JSON."]);
  }
  return parseSubordinates(raw, owner, path);
}

/** Validates an already-parsed registry document. Exposed for tests. */
export async function parseSubordinates(
  raw: unknown,
  owner: RegistryOwner,
  path = "<registry>",
): Promise<Subordinate[]> {
  const file = RegistryFileSchema.safeParse(raw);
  if (!file.success) {
    throw new SubordinateConfigError(path, [
      `the file must be {"subordinates": [...]}: ${z.prettifyError(file.error)}`,
    ]);
  }

  const issues: string[] = [];
  const subordinates: Subordinate[] = [];
  const seen = new Map<string, number>();
  const ownerThumbprint = await calculateJwkThumbprint({ ...owner.key.publicJwk }, "sha256");

  for (const [index, entry] of file.data.subordinates.entries()) {
    const at = `subordinates[${index}]`;
    const before = issues.length;
    const parsed = SubordinateEntrySchema.safeParse(entry);
    if (!parsed.success) {
      issues.push(`${at}: ${z.prettifyError(parsed.error)}`);
      continue;
    }
    const value = parsed.data;

    const entityId = validateEntityId(value.entity_id);
    if (!entityId.ok) {
      issues.push(`${at}.entity_id "${value.entity_id}": ${entityId.error.description}`);
    }
    const normalized = value.entity_id.replace(/\/$/, "");
    if (normalized === owner.entityId) {
      issues.push(`${at}.entity_id: the Trust Anchor cannot be its own subordinate.`);
    }
    const firstIndex = seen.get(normalized);
    if (firstIndex !== undefined) {
      issues.push(
        `${at}.entity_id "${value.entity_id}" duplicates subordinates[${firstIndex}]; each entity may be registered once.`,
      );
    } else {
      seen.set(normalized, index);
    }

    if (new Set(value.entity_types).size !== value.entity_types.length) {
      issues.push(`${at}.entity_types contains duplicates.`);
    }

    const keys = await validateJwks(value.jwks.keys, `${at}.jwks`, ownerThumbprint, issues);
    const metadataPolicy = validateMetadataPolicy(value.metadata_policy, at, issues);
    const constraints = validateConstraints(value.constraints, at, issues);

    if (issues.length === before) {
      subordinates.push({
        entityId: value.entity_id,
        enabled: value.enabled,
        entityTypes: value.entity_types,
        jwks: { keys },
        ...(metadataPolicy === undefined ? {} : { metadataPolicy }),
        ...(constraints === undefined ? {} : { constraints }),
      });
    }
  }

  if (issues.length > 0) {
    throw new SubordinateConfigError(path, issues);
  }
  return subordinates;
}

async function validateJwks(
  rawKeys: readonly unknown[],
  at: string,
  ownerThumbprint: string,
  issues: string[],
): Promise<JWK[]> {
  const keys: JWK[] = [];
  const kids = new Set<string>();
  for (const [index, rawKey] of rawKeys.entries()) {
    const keyAt = `${at}.keys[${index}]`;
    if (typeof rawKey === "object" && rawKey !== null) {
      const privateMembers = PRIVATE_JWK_MEMBERS.filter((member) => member in rawKey);
      if (privateMembers.length > 0) {
        issues.push(
          `${keyAt} contains private key material (${privateMembers.join(", ")}). ` +
            "Register only the subordinate's public key; the Trust Anchor must never hold it.",
        );
        continue;
      }
    }
    const parsed = PublicJwkSchema.safeParse(rawKey);
    if (!parsed.success) {
      issues.push(`${keyAt}: ${z.prettifyError(parsed.error)}`);
      continue;
    }
    const jwk = parsed.data;
    const problem = checkKeyMaterial(jwk);
    if (problem !== undefined) {
      issues.push(`${keyAt} (kid "${jwk.kid}"): ${problem}`);
      continue;
    }
    if (kids.has(jwk.kid)) {
      issues.push(`${keyAt}: kid "${jwk.kid}" is not unique within the JWK Set.`);
      continue;
    }
    kids.add(jwk.kid);
    // zod omits absent optional members, so the parsed object is the public JWK.
    const publicJwk: JWK = { ...jwk };
    if ((await calculateJwkThumbprint(publicJwk, "sha256")) === ownerThumbprint) {
      issues.push(
        `${keyAt} is the Trust Anchor's own federation key. Subordinates must use their own keys.`,
      );
      continue;
    }
    keys.push(publicJwk);
  }
  return keys;
}

function checkKeyMaterial(jwk: z.infer<typeof PublicJwkSchema>): string | undefined {
  if (jwk.kty === "EC") {
    const expectedAlg =
      jwk.crv !== undefined && Object.hasOwn(EC_CURVE_ALGORITHMS, jwk.crv)
        ? EC_CURVE_ALGORITHMS[jwk.crv]
        : undefined;
    if (expectedAlg === undefined) {
      return `EC keys must use P-256, P-384 or P-521 (got ${String(jwk.crv)}).`;
    }
    if (jwk.x === undefined || jwk.y === undefined) {
      return "EC keys need x and y.";
    }
    if (jwk.n !== undefined || jwk.e !== undefined) {
      return "EC keys must not carry RSA members.";
    }
    if (jwk.alg !== undefined && jwk.alg !== expectedAlg) {
      return `alg ${jwk.alg} does not match curve ${jwk.crv ?? ""} (expected ${expectedAlg}).`;
    }
  } else if (jwk.kty === "RSA") {
    if (jwk.n === undefined || jwk.e === undefined) {
      return "RSA keys need n and e.";
    }
    if (jwk.crv !== undefined || jwk.x !== undefined || jwk.y !== undefined) {
      return "RSA keys must not carry EC members.";
    }
    if (jwk.alg !== undefined && !Object.hasOwn(RSA_ALGORITHMS, jwk.alg)) {
      return `alg ${jwk.alg} is not a supported RSA signing algorithm.`;
    }
  } else {
    return `kty ${jwk.kty} is not supported; use EC or RSA.`;
  }

  try {
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (jwk.kty === "RSA" && (modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) {
      return `RSA modulus must be at least ${MIN_RSA_MODULUS_BITS} bits.`;
    }
  } catch {
    return "the key material is not a valid public key.";
  }
  return undefined;
}

function validateMetadataPolicy(
  policy: Record<string, unknown> | undefined,
  at: string,
  issues: string[],
): Subordinate["metadataPolicy"] {
  if (policy === undefined) {
    return undefined;
  }
  const parsed = FederationMetadataPolicySchema.safeParse(policy);
  if (!parsed.success) {
    issues.push(`${at}.metadata_policy: ${z.prettifyError(parsed.error)}`);
    return undefined;
  }
  let valid = true;
  for (const [entityType, parameters] of Object.entries(parsed.data)) {
    for (const [parameter, operators] of Object.entries(parameters)) {
      for (const operator of Object.keys(operators)) {
        if (!Object.hasOwn(STANDARD_POLICY_OPERATORS, operator)) {
          issues.push(
            `${at}.metadata_policy.${entityType}.${parameter}: operator "${operator}" is not a ` +
              "standard OpenID Federation 1.0 operator; metadata_policy_crit is not supported.",
          );
          valid = false;
        }
      }
    }
  }
  if (!valid) {
    return undefined;
  }
  // Checks each operator's value and that operators on one parameter may be combined (§6.1.3).
  const resolved = resolveMetadataPolicy([
    { header: {}, payload: { metadata_policy: parsed.data } as unknown as EntityStatementPayload },
  ]);
  if (!resolved.ok) {
    issues.push(`${at}.metadata_policy: ${resolved.error.description}`);
    return undefined;
  }
  return parsed.data;
}

function validateConstraints(
  constraints: Record<string, unknown> | undefined,
  at: string,
  issues: string[],
): Subordinate["constraints"] {
  if (constraints === undefined) {
    return undefined;
  }
  const unknown = Object.keys(constraints).filter(
    (member) => !Object.hasOwn(CONSTRAINT_MEMBERS, member),
  );
  const naming = constraints["naming_constraints"];
  if (typeof naming === "object" && naming !== null) {
    unknown.push(
      ...Object.keys(naming)
        .filter((member) => !Object.hasOwn(NAMING_CONSTRAINT_MEMBERS, member))
        .map((member) => `naming_constraints.${member}`),
    );
  }
  if (unknown.length > 0) {
    issues.push(`${at}.constraints: unsupported member(s) ${unknown.join(", ")}.`);
    return undefined;
  }
  const parsed = TrustChainConstraintsSchema.safeParse(constraints);
  if (!parsed.success) {
    issues.push(`${at}.constraints: ${z.prettifyError(parsed.error)}`);
    return undefined;
  }
  return constraints;
}
