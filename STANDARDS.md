# Standards

This document lists the standards this repository implements or relies on,
with exact versions and maturity, and the normative requirements the code
must satisfy. Nothing here claims certification, official conformance
testing, or recognition by any EUDI, IT-Wallet or other production trust
framework.

## Implemented

### OpenID Federation 1.0 (final)

- Identifier: OpenID Federation 1.0
- Status: **Final**, published 17 February 2026 by the OpenID Connect
  Working Group
- URL: <https://openid.net/specs/openid-federation-1_0-final.html>
- Role in this repository: Trust Anchor (federation authority with
  Immediate Subordinates, no Superiors)

Normative requirements implemented:

| Section    | Requirement                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3         | Entity Statements are JWS-signed JWTs with header `typ` = `entity-statement+jwt` and a `kid` header naming the signing key.                                                                                                                                      |
| §3.1.1     | `iss`, `sub`, `iat`, `exp`, `jwks` present in every statement; every JWK in `jwks` has a unique `kid`; `kid` is the RFC 7638 SHA-256 thumbprint (RECOMMENDED).                                                                                                   |
| §3.1.2     | The Trust Anchor's Entity Configuration has `iss` = `sub` and carries no `authority_hints` or `trust_anchor_hints`.                                                                                                                                              |
| §3.1.3     | Subordinate Statements carry `metadata_policy` and `constraints` only when configured; Entity-Configuration-only claims are never included.                                                                                                                      |
| §5.1.1     | `metadata.federation_entity` publishes `federation_fetch_endpoint` and `federation_list_endpoint` (both REQUIRED for Trust Anchors), as `https` URLs without fragments.                                                                                          |
| §6.1, §6.2 | Configured `metadata_policy` uses only the standard operators (`value`, `add`, `default`, `one_of`, `subset_of`, `superset_of`, `essential`); `constraints` uses `max_path_length`, `naming_constraints`, `allowed_entity_types`. Both are validated at startup. |
| §8.1       | Fetch endpoint: `GET` with `sub`; `200` + `application/entity-statement+jwt`; unknown `sub` → `404 not_found`; `sub` equal to the issuer → `400 invalid_request`.                                                                                                |
| §8.2       | List endpoint: `GET`; `200` + `application/json` array of Entity Identifiers; `entity_type` (repeatable) and `intermediate` filters supported; `trust_marked` and `trust_mark_type` → `400 unsupported_parameter`.                                               |
| §8.9       | Error responses are `application/json` objects with `error` and `error_description`.                                                                                                                                                                             |
| §9         | The Entity Configuration is served at the Entity Identifier with `/.well-known/openid-federation` appended (trailing `/` removed), using `GET`.                                                                                                                  |
| §11.2      | Key rollover procedure is documented (publish new key, keep signing with old key, switch, retire); automation is not implemented.                                                                                                                                |

Optional parts of the specification deliberately **not** implemented:
Resolve endpoint (§8.3), Trust Marks and their endpoints (§7, §8.4–§8.6),
Historical Keys endpoint (§8.7), client authentication at federation
endpoints (§8.8), Automatic and Explicit Registration (§12), Intermediate
Entities and multi-level hierarchies, `signed_jwks_uri`/`jwks_uri`
publication of federation keys. These endpoints are not advertised and return
`404 not_found`.

### Supporting IETF specifications

| Standard                                       | Used for                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| RFC 7515 — JSON Web Signature (JWS)            | Compact-serialized signed statements                 |
| RFC 7517 — JSON Web Key (JWK)                  | Key files and published `jwks`                       |
| RFC 7518 — JSON Web Algorithms (JWA)           | `ES256` (ECDSA P-256, SHA-256) for Trust Anchor keys |
| RFC 7519 — JSON Web Token (JWT)                | `iat`/`exp` NumericDate claims                       |
| RFC 7638 — JWK Thumbprint                      | Stable `kid` derivation                              |
| RFC 8725 — JWT Best Current Practices          | Explicit typing (`typ`) to prevent JWT confusion     |
| RFC 6749 §5.2 — OAuth 2.0 error response shape | `error` / `error_description` (via OIDF §8.9)        |

Trust Anchor signing keys are ES256 only. Subordinate keys may be EC
(P-256, P-384, P-521) or RSA (≥ 2048-bit modulus), matching the algorithms
`@oidfed/core` supports (`ES256`, `ES384`, `ES512`, `PS256`, `PS384`,
`PS512`, `RS256`).

### OpenAPI 3.1.0

- URL: <https://spec.openapis.org/oas/v3.1.0>
- Used for the public API description at `/openapi.yaml` and `/openapi.json`.
  Not a protocol requirement of the federation.

## Informative, not implemented

### OpenID Federation for Wallet Architectures 1.0

- Status: **Draft 06**, published 12 November 2026 — an evolving draft, not a
  final specification
- URL: <https://openid.net/specs/openid-federation-wallet-1_0.html>
- Use here: consulted for future issuer/verifier integration only. Its Entity
  Type Identifiers (`openid_credential_issuer`, `openid_credential_verifier`,
  `openid_wallet_provider`, `openid_credential_verifier_provider`) may appear
  as opaque `entity_types` values in the subordinate registry for listing and
  display. The Trust Anchor does not validate, generate or police any
  wallet-architecture metadata.

## Not applicable

- Earlier OpenID Connect Federation drafts are **not** interchangeable with
  OpenID Federation 1.0 final and are not followed.
- OpenID Federation 1.1, OpenID Federation for OpenID Connect 1.1 and the
  Extended Subordinate Listing, Subordinate Events and Entity Collection
  drafts are supported by the library but disabled or unadvertised here.
- EUDI ARF, IT-Wallet and other production trust frameworks, ETSI TS 119 612
  trusted lists and LoTL publication: out of scope. This Trust Anchor is a
  Credimi-operated test federation and is not recognized by any of them.
- OpenID4VCI and OpenID4VP: implemented by `credimi-capture-wallet`, not here.

## Verification approach

- The service's own tests check headers, claims, signatures, media types and
  error shapes against the requirements above.
- An end-to-end test resolves and verifies a Trust Chain from a locally
  generated subordinate to this Trust Anchor with
  `@openid-federation/core` (OpenWallet Foundation Labs), an implementation
  independent of the `@oidfed` packages used to produce the statements, and
  re-verifies every signature directly with `jose`.
- No external conformance suite has been run.
