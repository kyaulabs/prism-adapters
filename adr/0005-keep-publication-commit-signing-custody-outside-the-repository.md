# 0005. Keep publication commit-signing custody outside the repository

Date: 2026-08-31

## Status

Accepted

## Context

ADR-0004 chose a separate OpenPGP publication commit-signing identity, an offline certification key, an Ed25519 signing subkey, GnuPG, pinned public policy, and GitHub verification before ref creation. It placed encrypted recovery material under a gitignored repository-local `.custody/` directory.

Gitignore prevents accidental tracking but does not make a working-tree directory offline or separate it from repository-oriented tools. Keeping recovery material outside the repository gives the custody boundary a simpler invariant: the repository contains only the reviewed public export and fingerprints, while private material never enters its path namespace.

The human administrator has provisioned the identity `kyaulabs-bot <actions@kyaulabs.com>` with primary certification fingerprint `646340DAD3387E48F047B5C049659B98769C17D6` and signing-subkey fingerprint `0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE`.

## Decision

We retain ADR-0004's separate OpenPGP authority, fixed identity, signing-subkey model, GnuPG boundary, GitHub verification gate, secret names, transaction ordering, and human-only sequence-2 recovery. We replace only its repository-local custody location.

Human-managed encrypted certification material, encrypted signing-subkey exports, and offline public-key copies live in a dedicated directory outside every repository worktree. The passphrase remains separately protected and does not live beside the key exports. The custody directory is owner-restricted and its absolute path is added to `PRISM_SENSITIVE_PATHS` before agent sessions. Agents never inspect, generate, copy, or operate on that directory or its contents.

The repository contains only `publication-commit-signing-public.asc` and trusted public fingerprint constants. The committed public export identifies `kyaulabs-bot <actions@kyaulabs.com>`, primary fingerprint `646340DAD3387E48F047B5C049659B98769C17D6`, and signing-subkey fingerprint `0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE`. Reviewing and parsing this public-only policy is permitted; private or recovery material remains forbidden.

The external local directory is encrypted custody, not proof of offline storage. Human administrators keep a genuinely offline recovery copy on separately controlled storage.

This decision supersedes ADR-0004.

## Consequences

- **Positive:** private and recovery material cannot be staged or committed from the publisher worktree.
- **Positive:** repository-oriented agents and automation have a simpler deny boundary.
- **Positive:** the repository still pins the exact public identity needed for deterministic protected verification.
- **Negative:** maintainers must back up and locate an external custody directory independently of the repository.
- **Negative:** moving or restoring custody requires updating `PRISM_SENSITIVE_PATHS` before agent access resumes.
- **Neutral:** protected-environment secret provisioning and all publication behavior remain unchanged from ADR-0004.

## Alternatives Considered

### Keep the gitignored repository-local custody directory

Rejected because ignore rules prevent tracking but do not separate private material from the worktree or repository-oriented tooling.

### Store only the protected-environment copy

Rejected because GitHub cannot reveal stored secret values and cannot replace offline recovery custody.

### Commit encrypted private exports

Rejected because encryption does not justify placing production signing authority in Git history, clones, mirrors, caches, or agent-visible paths.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
