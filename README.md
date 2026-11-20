# credimi-federation

An OpenID Federation 1.0 Trust Anchor for Credimi development and
interoperability testing.

**Credimi** is the trustworthy compliance checker for decentralized identity
solutions, built and operated by Forkbomb BV (Amsterdam) under the NGI
TRUSTCHAIN programme. This repository is a Credimi Extra.

Issuers, verifiers and wallet providers that want to prove federation
membership need a Trust Anchor that publishes signed statements about them.
This service is that Trust Anchor for a small, self-hosted federation, starting
with the issuers and verifier of
[credimi-capture-wallet](https://github.com/ForkbombEu/credimi-capture-wallet).
It is a **test federation operated by Credimi**. It is not an officially
recognized EUDI or IT-Wallet Trust Anchor.

> Status: in development. Identity, persistent signing key, Entity
> Configuration, declarative subordinate registration and the fetch/list
> endpoints are implemented; the web interface and deployment follow.

## Technical specs

- Node.js with TypeScript (strict), Fastify, pnpm.
- [`@oidfed/authority`](https://github.com/Dahkenangnon/oidfed) and
  `@oidfed/core` for OpenID Federation 1.0 statement issuance.
- `jose` for key generation and key handling.

Runtime versions, dependencies and architecture are recorded in
[SPECS.md](SPECS.md); applicable standards in [STANDARDS.md](STANDARDS.md).

## How to run

```sh
mise install        # Node.js, pnpm and Task
task install        # pnpm install --frozen-lockfile

export FEDERATION_ENTITY_ID=https://federation.credimi.io
export FEDERATION_SIGNING_KEY_PATH=./data/keys/federation.jwk
export FEDERATION_SUBORDINATES_PATH=./data/subordinates.json

task init           # once: creates the ES256 key (mode 0600), never overwrites
echo '{"subordinates": []}' > ./data/subordinates.json
task run            # http://localhost:3000
```

Checks: `task lint`, `task test`, `task build`.

## Registering a subordinate

Membership is the JSON file at `FEDERATION_SUBORDINATES_PATH`; there is no
registration endpoint. Each entry pins the subordinate's **public** federation
keys, obtained from its operator over a trusted channel — never from its
reachable Entity Configuration alone. See
[config/subordinates.example.json](config/subordinates.example.json).

| Member            | Required | Meaning                                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------------------- |
| `entity_id`       | yes      | The subordinate's Entity Identifier (`https`, no query or fragment)                     |
| `enabled`         | yes      | `false` keeps the entry visible but out of fetch and list                               |
| `jwks`            | yes      | `{"keys": [...]}` public EC (P-256/384/521) or RSA (≥ 2048-bit) keys, each with a `kid` |
| `entity_types`    | no       | Entity Type Identifiers, used for listing and display                                   |
| `metadata_policy` | no       | OpenID Federation 1.0 §6.1 policy, standard operators only                              |
| `constraints`     | no       | `max_path_length`, `naming_constraints`, `allowed_entity_types` (§6.2)                  |

The file is validated on start and by `node dist/cli.js check`; duplicates,
private key members, the Trust Anchor's own key, unknown members and invalid
policies are rejected and the service does not start. Restart after editing.

## CLI examples

| Command | Example                                | Effect                                     |
| ------- | -------------------------------------- | ------------------------------------------ |
| `init`  | `node dist/cli.js init`                | Create the federation signing key once     |
| `check` | `node dist/cli.js check`               | Validate configuration and key, then exit  |
| `jwks`  | `node dist/cli.js jwks > ta.jwks.json` | Export the public JWK Set for distribution |

## API examples

| Endpoint                             | Example                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-federation` | `curl -s http://localhost:3000/.well-known/openid-federation`                           |
| `GET /federation_fetch?sub=…`        | `curl -s 'http://localhost:3000/federation_fetch?sub=https%3A%2F%2Fissuer.example.org'` |
| `GET /federation_list`               | `curl -s http://localhost:3000/federation_list`                                         |
| `GET /healthz`                       | `curl -s http://localhost:3000/healthz`                                                 |

## Governance

Read [AGENTS.md](AGENTS.md) and [directives/](directives/) before
contributing. Design rules are in [DESIGN.md](DESIGN.md); the canonical brand
assets are in [brand/](brand/).
