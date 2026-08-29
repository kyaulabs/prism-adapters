# Project Context

> Living record of the publisher domain, invariants, and boundaries.

## Purpose

`kyaulabs/prism-adapters` publishes the signed supported-adapter catalogue consumed by strict-empty Prism `/setup`. It owns independent release-evidence validation, deterministic catalogue source, catalogue envelope verification, and the publisher side of the cross-repository catalogue publication transaction.

Prism Core owns adapter release declarations and emits minimal release notifications. This repository treats those notifications as trigger hints and reconstructs authority from immutable Prism release evidence, exact npm metadata, and the signature-verified current catalogue.

## Domain Glossary

| Term | Definition |
| --- | --- |
| supported-adapter catalogue | The schema-versioned, KYAULabs-signed list of approved adapter identities and exact releases eligible for strict-empty Prism setup. |
| adapter release declaration | The closed, reviewed Prism release-commit record identifying a catalogued release-managed adapter package, compatibility range, bootstrap protocol, and publication status without registry or signing authority. |
| release evidence | The agreeing stable Prism Release, immutable merge commit, package tag, release-managed manifest version, adapter release declaration, and exact npm integrity and publication time. |
| trigger hint | A closed dispatch or recovery input that identifies where validation starts but supplies no compatibility, package, registry, sequence, branch, or signing authority. |
| verified current catalogue | The signature-verified catalogue from attested publisher `main`; expiry may be tolerated only where the accepted transaction permits sequence recovery. |
| release update | A transaction that validates one exact release and adds or replaces only that release record in the verified current release set. |
| renewal | A transaction that preserves the verified current release set, revalidates every exact npm release, and prepares a fresh validity window without discovering or removing releases. |
| deterministic catalogue source | The complete unsigned source policy rendered solely from validated release evidence and preserved verified records. |
| catalogue publication transaction | The serialized cross-repository workflow that validates evidence, signs the next sequence in the protected publisher environment, and opens a human-merged publication pull request. |
| protected signing environment | The dedicated GitHub Actions environment that exposes separate encrypted-key and passphrase secrets only to trusted default-branch catalogue signing code. |

## Entities and Invariants

### Publisher Evidence Resolver

- Independently validates release evidence; caller, dispatch, recovery, and local source values are never compatibility or package authority.
- Accepts only the fixed Prism repository, stable releases, immutable commits, matching package tags, release-managed public packages, closed declarations, and exact versions.
- Requires exact agreement among the Release, commit, tag, manifest, declaration, and npm evidence.
- Rejects unknown fields, mutable refs, prereleases, redirects, oversized responses, malformed values, mismatches, and partial evidence.

### npm Evidence Boundary

- Uses the fixed public npm registry and exact package versions only.
- Accepts canonical SHA-512 integrity and canonical publication time.
- Never selects `latest`, follows redirects, accepts caller-selected origins, or gains npm publication authority.
- Uses bounded retries and an overall timeout; exhaustion fails closed.

### Catalogue Source Renderer

- Starts from a verified current catalogue rather than unsigned local policy.
- A release update adds or replaces only its exact record and preserves unrelated releases and statuses.
- A renewal preserves the complete verified release set and revalidates each exact npm release.
- Equivalent evidence produces deterministic source bytes.

### Protected Signing Environment

- Runs only trusted `main` publisher code on a GitHub-hosted ephemeral runner after unprivileged validation and synthetic-key tests pass.
- Receives the encrypted PKCS#8 Ed25519 key and passphrase as separate environment-scoped GitHub Actions secrets.
- Matches the committed Core SPKI fingerprint and key ID, signs and reverifies exact prepared payload bytes, and removes runner-private secret material on every exit path.
- Produces no secret-bearing argument, log, output, summary, artifact, cache, fixture, or local state.
- Remains activation-gated until human maintainers provision the environment, bound Actions log retention, and offline recovery custody.

### Catalogue Publication Transaction

- All release dispatch, manual recovery, and due scheduled renewal runs share one non-cancelling transaction; a daily schedule applies a verified three-day renewal gate.
- Each run binds the next sequence, deterministic source, signed envelope, and publication intent to an attested `main` commit, then rechecks that base before publication.
- A sequence branch is immutable after atomic creation. Automation never updates or force-pushes it.
- Only exact partial branch or pull-request state is recoverable; conflicting bytes, base, signature, sequence, or open publication state fails closed.
- A repository-narrowed GitHub App token creates only the sequence branch and pull request. Human maintainers review and merge every publication pull request.

### Failure Boundary

- Evidence failure or retry exhaustion produces no prepared signing payload and performs no signing or Git mutation.
- A later dispatch, renewal, or manual recovery recomputes from current authority rather than resuming partial state.
- Production secrets never enter local code, tests, fixtures, arguments, logs, artifacts, or agent context.

## System Boundaries

### This repository owns

- Publisher-side GitHub and npm evidence validation.
- Deterministic catalogue source rendering.
- Public catalogue payload and envelope validation.
- Publisher workflow behavior assigned by the accepted cross-repository transaction.

### This repository delegates

- **Prism Core** — release-managed package configuration, adapter release declarations, stable Release and package-tag production, and minimal dispatch.
- **GitHub** — immutable repository evidence, environment-scoped secret storage, ephemeral Actions runners, protected Actions environments, narrowed App installation tokens, and human-reviewed pull requests.
- **npm** — exact public package integrity and publication-time evidence; npm publication remains human-owned.
- **Human maintainers** — administer signing and App credentials, review automation authority and succession, and merge every catalogue publication pull request.

### Boundary interfaces

- Closed trigger hints containing only schema, repository identity, stable version, and immutable merge commit.
- Bounded GitHub responses for the Release, commit, tag, manifest, and declaration.
- Bounded npm responses for exact package metadata.
- Signature-verified current catalogue input and deterministic source output.

## Non-Goals

- Treating dispatch, local source, npm tags, or SemVer inference as compatibility authority.
- Supporting arbitrary repositories, package scopes, registries, signing algorithms, or caller-selected destinations.
- Automating npm authentication or publication.
- Exposing production signing credentials to agents, local commands, pull requests, or tests.
- Pushing protected branches, force-pushing publication branches, enabling auto-merge, or merging pull requests.
- Changing adapter bootstrap behavior unrelated to catalogue publication.

## Architectural Decisions

- `adr/0001-adopt-prism-catalogue-publication-authority.md` — adopt the immutable Prism publication specification and ADRs as this publisher's authority while keeping issue #3 bounded to evidence resolution and deterministic source rendering.

## When to Update This File

Update this record when publisher domain terms, evidence invariants, system boundaries, non-goals, or accepted ADRs change. Keep implementation paths and test commands in plans and code documentation.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
