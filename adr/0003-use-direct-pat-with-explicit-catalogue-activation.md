# 0003. Use a direct PAT with explicit catalogue activation

Date: 2026-08-31

## Status

Accepted

## Context

ADR-0002 replaced GitHub App publication authentication with a separately owned, repository-scoped fine-grained PAT. It also removed `CATALOGUE_SIGNING_ENABLED`, treating protected-environment entry and trusted default-branch runner provenance as sufficient activation controls.

A manual production dispatch then entered the protected job, signed catalogue bytes, created a sequence branch, and opened a publication pull request while the activation variable was absent. The pull request was closed without merge and the branch was deleted. The incident showed that environment policy and runner provenance authenticate the execution context but do not record the separate human decision to activate production signing and publication.

The direct PAT remains the narrow publication credential. The missing control is an independent, reviewed activation boundary that fails closed before any protected credential or mutation path becomes available.

## Decision

We retain direct publication authentication through the environment-scoped `CATALOGUE_PUBLICATION_TOKEN` defined by ADR-0002 and restore explicit catalogue activation.

The `protected-signing` workflow job runs only when the repository Actions variable `CATALOGUE_SIGNING_ENABLED` has the exact string value `true`, in addition to the existing repository, ref, event, synthetic-validation, and protected-environment checks. Missing and non-exact values skip the complete protected job, including signing and publication.

After the job-level guard succeeds, the workflow passes a fixed `CATALOGUE_SIGNING_ENABLED: 'true'` capability marker into the protected job. The protected signing runner independently requires that exact marker before calling the signing boundary. Synthetic validation remains outside the activation gate.

Human maintainers set the repository variable only after reviewing environment provisioning, deployment policy, credential custody, log retention, workflow code, and recovery readiness. Removing or changing the variable disables future protected runs without affecting synthetic validation.

This decision supersedes ADR-0002. Its direct-PAT authentication, scope, custody, sequence-safety, recovery, and human-merge decisions remain in force; only its rejection of an explicit activation variable is reversed.

## Consequences

- **Positive:** production signing and publication require a distinct human activation decision in addition to authenticated workflow provenance.
- **Positive:** job-level and runner-level checks provide defense in depth against workflow or call-site drift.
- **Positive:** synthetic validation remains available before activation.
- **Positive:** the publication PAT remains separately owned, repository-scoped, and unavailable to unguarded jobs.
- **Negative:** scheduled renewal and release publication remain disabled until maintainers set the exact activation value.
- **Negative:** maintainers must review and manage one repository Actions variable as part of production custody.
- **Neutral:** no production credential format, scope, storage location, or rotation procedure changes.

## Alternatives Considered

### Rely on the protected environment and runner provenance

Rejected because those controls allowed the unactivated manual dispatch. They establish where trusted code runs, not whether maintainers have activated production authority.

### Guard only the signing step

Rejected because the protected job would still start and expose environment-scoped authority before activation. The complete protected job must be skipped.

### Validate activation only in the workflow

Rejected because a runner-side exact check protects the signing boundary from future workflow or call-site drift.

### Pass the raw repository variable through the job

Rejected because the job already proves exact activation. Passing a fixed capability marker narrows the runner input and avoids propagating malformed state.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
