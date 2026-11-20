# Project Specifications

## Template status

This repository was created from the Credimi Extras template. The template
required the derived project to choose exactly one backend stack and record
the decision here before implementation. This document is that record.

## Selected backend and rationale

**Node.js with TypeScript.**

- The human brief for this repository selects Node.js, TypeScript (strict
  mode), Fastify and pnpm.
- The only maintained OpenID Federation 1.0 authority implementation that
  matches the brief's requirements is a TypeScript library
  (`@oidfed/authority`, see below). Using it avoids writing federation
  statement assembly and signing logic by hand.
- The first federation members live in `credimi-capture-wallet`, which is a
  Node.js/TypeScript (Credo.TS) application. Sharing the stack keeps the
  integration documentation and test tooling uniform.

There is one backend stack. Do not add Go code or a second server stack.

## Language and runtime versions

| Tool       | Version             | Where it is pinned                                  |
| ---------- | ------------------- | --------------------------------------------------- |
| Node.js    | `latest` (dev)      | `mise.toml` (`node = "latest"`, required by BARIO)  |
| Node.js    | `26.13.1` (runtime) | `Dockerfile` base image `node:26.13.1-alpine`       |
| Node.js    | `>=26`              | `package.json` `engines`                            |
| pnpm       | `12.21.0`           | `mise.toml` and `package.json` `packageManager`     |
| Task       | `latest`            | `mise.toml`                                         |
| TypeScript | `6.0.3`             | `package.json`; TS 7 is not yet supported by ESLint |

At the time of writing `mise` resolves `node = "latest"` to `26.13.1`, the
same version as the production image. The production image is the
authoritative runtime; local development follows `mise`.

## Module or package identity

- npm package name: `credimi-federation` (private, not published).
- ES modules only (`"type": "module"`), compiled by `tsc` to `dist/`.
- Executables: `dist/server.js` (HTTP service) and `dist/cli.js`
  (`credimi-federation` CLI).
- License: Apache-2.0.

## Frameworks and dependencies

Runtime dependencies (all pinned to exact versions in `package.json`):

| Package             | Version   | License    | Purpose                                                                        |
| ------------------- | --------- | ---------- | ------------------------------------------------------------------------------ |
| `@oidfed/authority` | `2.0.0`   | Apache-2.0 | `TrustAnchor`: Entity Configuration, Subordinate Statements, fetch/list        |
| `@oidfed/core`      | `2.0.0`   | Apache-2.0 | Federation key provider, entity-ID validation, metadata policy schemas         |
| `jose`              | `6.2.13`  | MIT        | Key generation, JWK thumbprints, key import (same version `@oidfed/core` pins) |
| `fastify`           | `5.12.8`  | MIT        | HTTP server                                                                    |
| `@fastify/static`   | `10.1.12` | MIT        | Static brand and application assets                                            |
| `zod`               | `4.6.7`   | MIT        | Configuration validation (same version `@oidfed/core` pins)                    |
| `yaml`              | `2.9.1`   | ISC        | Parse the authoritative OpenAPI YAML to derive the JSON form                   |

Development dependencies: `typescript`, `@types/node`, `vitest`, `eslint`,
`@eslint/js`, `typescript-eslint`, `globals`, `prettier`, `stylelint`,
`stylelint-value-no-unknown-custom-properties`, and `@openid-federation/core`
(`0.2.1`, Apache-2.0, OpenWallet Foundation Labs — used only by the
interoperability test as an independent trust-chain resolver).

API documentation is rendered in the browser by Stoplight Elements `9.0.29`,
loaded from `unpkg.com` at that exact version by the `/docs` page only.

### Library evaluation: `@oidfed/authority` and `@oidfed/core`

Evaluated at version `2.0.0` (published November 2026, Apache-2.0,
source <https://github.com/Dahkenangnon/oidfed>).

- Targets the final OpenID Federation 1.0 specification.
- `TrustAnchor` exposes a fetch-compatible `handleRequest(Request)` that serves
  the Entity Configuration, fetch and list endpoints on the paths advertised in
  `metadata.federation_entity`, and returns 404 for every endpoint that is not
  advertised (resolve, historical keys, extended listing, trust marks).
- Verified behaviour (probe against the installed version): `typ` is
  `entity-statement+jwt`, `kid` is present, responses use
  `application/entity-statement+jwt`, unknown `sub` returns `404 not_found`,
  a `sub` equal to the issuer returns `400 invalid_request`, trust-mark list
  filters return `400 unsupported_parameter`, all as §8 of the specification
  requires or recommends.
- Signing goes through `jose`; no custom cryptography.
- Gap handled locally: a non-GET request returns
  `{"error":"method_not_allowed"}` without `error_description`, which is not
  the §8.9 error shape. Fastify routes only `GET`/`HEAD` to the library and
  answers other methods itself with a §8.9-shaped `405`.

Decision: adopt both packages. The `MemoryStorageAdapter` is used as an
in-process, read-only index that is rebuilt from the declarative subordinate
file on every start; it is never written at runtime, so its "development-only"
label (which refers to persistence) does not apply.

## Application architecture

```text
credimi-federation (one Node.js process)
  Fastify
    ├── federation routes  ──► @oidfed/authority TrustAnchor.handleRequest
    │     /.well-known/openid-federation   Entity Configuration (self-signed)
    │     /federation_fetch?sub=…          Subordinate Statement
    │     /federation_list                 Subordinate listing
    ├── /healthz                           liveness/readiness (JSON)
    ├── /openapi.yaml, /openapi.json       OpenAPI 3.1 (YAML is authoritative)
    ├── /docs                              Stoplight Elements
    ├── /, /inspect                        read-only server-rendered UI
    └── /assets/*, /favicon.svg            brand and application assets
```

- **Identity.** The Entity Identifier comes only from `FEDERATION_ENTITY_ID`.
  Every advertised URL is derived from it. Requests are forwarded to the
  library with a URL rebuilt from the configured identifier and the request
  path; the `Host` and `X-Forwarded-*` headers are never read.
- **Keys.** The Trust Anchor's private federation signing key is a single
  ES256 JWK file created once by `credimi-federation init`. Startup loads it,
  validates it (P-256, `alg` ES256, `kid` equals its RFC 7638 thumbprint,
  private/public halves match, file not group/world accessible) and refuses to
  start otherwise. Startup never creates or replaces keys.
- **Membership.** Subordinates are declared in a JSON file holding each
  subordinate's Entity Identifier, pinned public federation JWKS, entity
  types, enabled flag and optional `metadata_policy`/`constraints`. The file
  is validated at startup; any error aborts startup. Enabled entries are
  registered with the `TrustAnchor`; disabled ones are shown in the UI but are
  not served by fetch or list.
- **No impersonation.** The service never holds subordinate private keys and
  never publishes Entity Configurations for other entities. It only signs
  Subordinate Statements about pinned public keys.
- **No database.** All state is the key file plus the subordinate file.

## CLI, web, and API interfaces

CLI (`credimi-federation`, also `node dist/cli.js`):

| Command | Behaviour                                                                                |
| ------- | ---------------------------------------------------------------------------------------- |
| `init`  | Generate the ES256 federation key at `FEDERATION_SIGNING_KEY_PATH`; refuse to overwrite. |
| `check` | Validate the key and subordinate file exactly as startup does, then exit.                |
| `jwks`  | Print the Trust Anchor's public JWKS (for out-of-band distribution).                     |

HTTP (all `GET`, no authentication, no write operations):

| Path                             | Response                                         |
| -------------------------------- | ------------------------------------------------ |
| `/.well-known/openid-federation` | `application/entity-statement+jwt`               |
| `/federation_fetch?sub=…`        | `application/entity-statement+jwt` or §8.9 error |
| `/federation_list`               | `application/json` array or §8.9 error           |
| `/healthz`                       | `application/json` `{"status":"ok"}`             |
| `/openapi.yaml`, `/openapi.json` | OpenAPI 3.1                                      |
| `/docs`                          | HTML, Stoplight Elements                         |
| `/`                              | HTML homepage                                    |
| `/inspect`, `/inspect?sub=…`     | HTML decoded view of a signed statement          |

## Configuration

Environment variables (validated at startup; invalid values abort):

| Variable                       | Required | Default                          | Meaning                                                    |
| ------------------------------ | -------- | -------------------------------- | ---------------------------------------------------------- |
| `FEDERATION_ENTITY_ID`         | yes      | —                                | `https` origin of the Trust Anchor, no path/query/fragment |
| `FEDERATION_SIGNING_KEY_PATH`  | yes      | —                                | Private ES256 JWK file                                     |
| `FEDERATION_SUBORDINATES_PATH` | yes      | —                                | Subordinate registry JSON file                             |
| `PORT`                         | no       | `3000`                           | TCP port; the service binds `0.0.0.0`                      |
| `FEDERATION_NAME`              | no       | `OpenID Federation Trust Anchor` | Display name on the website                                |

The Docker image sets `FEDERATION_SIGNING_KEY_PATH=/data/keys/federation.jwk`
and `FEDERATION_SUBORDINATES_PATH=/data/subordinates.json`.
`.env.example` documents a complete local configuration.

## Build, format, lint, and test commands

All commands run through Task; `mise install` provides Node.js, pnpm and Task.

| Command             | What it runs                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `task install`      | `pnpm install --frozen-lockfile`                                                                                                 |
| `task format`       | `prettier --write .`                                                                                                             |
| `task format:check` | `prettier --check .`                                                                                                             |
| `task lint`         | ESLint (strict type-checked), stylelint undefined-custom-property check, `tsc --noEmit`, Prettier check, then `task lint:design` |
| `task lint:design`  | `npx --yes @google/design.md lint DESIGN.md`                                                                                     |
| `task test`         | `vitest run`                                                                                                                     |
| `task build`        | `tsc -p tsconfig.build.json`                                                                                                     |
| `task run`          | build, then `node --env-file-if-exists=.env dist/server.js`                                                                      |
| `task init`         | build, then `dist/cli.js init`                                                                                                   |
| `task check`        | build, then `dist/cli.js check`                                                                                                  |
| `task ci`           | format check, lint, test, build                                                                                                  |
| `task docker:build` | `docker build -t credimi-federation:local .`                                                                                     |

## Production and Docker execution

- Multi-stage `Dockerfile` on `node:26.13.1-alpine`; the runtime stage holds
  only `dist/`, production `node_modules`, `public/` and `openapi/`.
- Runs as the image's non-root `node` user (uid 1000).
- `/data` is a declared volume owned by `node`; it holds `keys/federation.jwk`
  (mode `0600` in a `0700` directory) and `subordinates.json`.
- The container never generates keys. Provision once with
  `docker run --rm -v <volume>:/data <image> node dist/cli.js init`.
  Starting without the key or subordinate file fails with a clear error.
- `HEALTHCHECK` calls `GET /healthz` on `$PORT`.
- Behind Coolify (or any TLS-terminating proxy) only the proxy's public
  hostname must match `FEDERATION_ENTITY_ID`; the internal hostname and port
  never appear in responses.

## Important directories

| Path       | Contents                                                                |
| ---------- | ----------------------------------------------------------------------- |
| `src/`     | TypeScript sources                                                      |
| `tests/`   | Vitest suites                                                           |
| `openapi/` | `openapi.yaml`, the authoritative API description                       |
| `public/`  | Runtime static assets: `brand/` (copy of `brand/`), `app.css`, `app.js` |
| `brand/`   | Canonical Credimi design assets (do not edit logos)                     |
| `config/`  | Example subordinate registry (no real keys)                             |
| `docs/`    | Template notes and the federation integration guide                     |

Runtime asset locations: `public/brand/style.css`, `public/brand/fonts/`,
`public/brand/logos/` are byte-identical copies of `brand/`; tests enforce the
logo SHA-256 pins from `DESIGN.md` §1 and byte equality of every copied file.
`public/app.css` loads after `public/brand/style.css`.

## Generated files

- `dist/` — compiled output, ignored by Git.
- `pnpm-lock.yaml` — committed lockfile.
- `pnpm-workspace.yaml` — written by pnpm to exempt freshly published pinned
  packages from its minimum-release-age check; committed.

## Repository-specific constraints

- Never commit private keys, `.env`, or `/data`. `*.jwk` is ignored.
- Never generate or replace the federation key during normal startup.
- Never derive URLs from request headers.
- Never add an unauthenticated write or registration endpoint.
- Never hold or publish subordinate private keys.
- Protocol logic must not hardcode `federation.credimi.io` or any Credimi
  entity identifier; those appear only in examples and documentation.
- OpenID4VCI/OpenID4VP flows belong in `credimi-capture-wallet`, not here.
