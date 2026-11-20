# HITL.md

## ⚠️ Human In The Loop

This file contains observations that require human validation.

It is a controlled buffer between:

- agent discovery
- human decision
- doctrine (`BARIO.md`)

---

## Rules

- entries are NOT authoritative
- entries MUST NOT influence agent decisions
- this file is **write-only for agents**
- only humans may promote entries into `BARIO.md`

Agents MUST:

- append new valid observations
- NEVER modify or delete existing entries
- keep entries minimal and factual

---

## Constraints

Only add an entry if:

- the pattern appears at least twice
- it may impact architecture, naming, or workflow

If unsure:

→ DO NOT add  
→ DO NOT assume

---

## Entry Template

- id: hitl-XXXX
- observation:
- location:
- evidence:
- rationale:

---

## Entries

- id: hitl-0001
- observation: Required validation tooling is missing for pre-commit checks.
- location: repository root
- evidence: `task lint` fails with `task: command not found`; `Taskfile.yml` and `mise.toml` are absent.
- rationale: `BARIO.md` requires formatting and linting before commits, with required tools declared in `mise.toml`.

- id: hitl-0002
- observation: Repository formatting rule is missing.
- location: repository root
- evidence: `Taskfile.yml` defines `lint` and `lint:design`, but no formatting task or formatter is defined.
- rationale: `BARIO.md` requires formatting through a repository-defined formatter before commits.

- id: hitl-0003
- observation: The canonical stylesheet was moved out of `HITL/` and edited, contradicting a frozen human brief.
- location: `brand/style.css`, `HITL/01-harmonize-credimi-extras.md`
- evidence: `HITL/01-harmonize-credimi-extras.md` names `HITL/style.css` as the canonical design input and requires byte-equality tests against it. On human instruction the file was moved to `brand/style.css` and merged with the design system's `colors_and_type.css`; its SHA-256 pin no longer applies. The four logo SVGs moved to `brand/logos/` unchanged, so their pins still verify.
- rationale: The frozen brief and the current asset layout disagree. Either the brief is superseded and should be reissued, or the merge should be reverted. Only a human can decide which.

- id: hitl-0004
- observation: Both empty-state illustrations named by the design spec are unusable.
- location: Credimi Design System project, `assets/404-computer.svg` and `assets/maintenance.svg`
- evidence: Each file is a `<rect>` filled by a pattern referencing an `<image>` element that carries no data. Nothing renders. `DESIGN.md` §9 and §12 require an illustration in every empty and error state.
- rationale: The requirement cannot be met until working files exist upstream.

- id: hitl-0005
- observation: The `Taskfile.yml` block in `BARIO.md` prescribes Go commands (`go test`, `go run`, `go build`) without a Go-only condition, while Node.js/TypeScript Credimi Extras exist.
- location: `directives/BARIO.md` § Taskfile; `Taskfile.yml`
- evidence: This repository and `credimi-capture-wallet` are Node.js/TypeScript; both keep the `test`, `lint`, `lint:design`, `run`, `build` task names but run pnpm equivalents.
- rationale: The rule should state whether the Go commands apply only to Go projects, or what Node.js projects must run instead.

- id: hitl-0006
- observation: `BARIO.md` requires `node = "latest"` in `mise.toml` when `DESIGN.md` is present, which leaves the Node.js runtime of Node.js projects unpinned in development.
- location: `directives/BARIO.md` § Design Source; `mise.toml`; `Dockerfile`
- evidence: This repository and `credimi-capture-wallet` both declare `node = "latest"`; here the production image pins `node:26.13.1-alpine`, so development and production can drift when a new Node.js major is released.
- rationale: The rule was written for running the design lint; a human should decide whether Node.js projects may pin their runtime in `mise.toml`.

- id: hitl-0007
- observation: The required top navigation for API applications (Home, API docs, OpenAPI, Repository) is defined only in a brief scoped to four other repositories.
- location: `HITL/01-harmonize-credimi-extras.md` § Required navigation; `DESIGN.md`
- evidence: `credimi-capture-wallet` and this repository both expose `/docs` and a raw OpenAPI document and link them from the topbar; `DESIGN.md` defines no navigation set.
- rationale: If the navigation set is meant to apply to every Credimi Extra with an API, it belongs in `DESIGN.md` or `BARIO.md`.

- id: hitl-0008
- observation: Several shared brand components set small text in `--fg-muted` (#9A97B5), `--warning` (#E9B93B) or `--success` (#058A57) on light fills, below the WCAG AA 4.5:1 contrast ratio for normal text.
- location: `brand/style.css` `.hero p`, `.dl dt`, `.test-table th`, `.badge-neutral`, `.badge-issuer`, `.status-issuer`, `.status-verifier`
- evidence: Computed WCAG ratios: #9A97B5 on #EEEAFE (lavender wash) 2.39:1, on #FFFFFF 2.81:1; #E9B93B on #FDF3D5 1.65:1; #058A57 on #E5F4EC 3.87:1. This repository overrides only its hero lead paragraph to `--fg-subtle` (5.10:1) in `public/app.css`; `HITL/01-harmonize-credimi-extras.md` requires WCAG AA.
- rationale: Fixing contrast in each application redefines shared components; changing the tokens or rules is a brand decision that needs Design sign-off.
