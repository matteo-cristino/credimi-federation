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

> Status: in development. Project specifications and tooling are in place; the
> service is implemented in subsequent commits.

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
task lint           # ESLint, stylelint, tsc, Prettier check, design lint
task test
```

## Governance

Read [AGENTS.md](AGENTS.md) and [directives/](directives/) before
contributing. Design rules are in [DESIGN.md](DESIGN.md); the canonical brand
assets are in [brand/](brand/).
