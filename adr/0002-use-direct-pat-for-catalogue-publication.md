# 0002. Use a direct PAT for catalogue publication

Date: 2026-08-30

## Status

Accepted

## Context

ADR-0001 adopts the cross-repository catalogue publication transaction recorded by Prism ADR-0095. That design used a dedicated GitHub App: protected publisher code signed an App JWT, discovered the installation, and minted a repository- and permission-narrowed installation token before publishing.

The approved two-PAT design assigns separate credentials to trigger delivery and catalogue publication. This repository owns only the publication side. Its credential is a fine-grained PAT owned by `kyaulabs-bot`, with resource owner `kyaulabs`, repository access limited to `kyaulabs/prism-adapters`, and only Contents write and Pull Requests write permissions. It has no Actions write permission.

Direct authentication removes App ID and private-key custody, JWT construction, installation discovery, and installation-token minting. It must not weaken the existing evidence, signing, sequence-safety, recovery, or human-merge controls. The PAT value remains outside repository, test, local command, agent, and log contexts.

## Decision

We authenticate the protected catalogue publication command directly with the environment-scoped secret `CATALOGUE_PUBLICATION_TOKEN`.

The `catalogue-signing` protected environment injects this secret only into the publication step after public-evidence validation, synthetic-key tests, production signing, and reverification. Trusted default-branch publisher code treats it as an opaque environment value and passes it only to the fixed `kyaulabs/prism-adapters` GitHub API boundary. Code does not inspect, transform, persist, print, or validate the credential against GitHub.

We remove all publication GitHub App inputs and behavior. `CATALOGUE_SIGNING_ENABLED` remains absent; entry into the protected environment and trusted-runner provenance checks gate production signing and publication.

The transaction continues to create an absent sequence ref atomically, never update or force-push a sequence branch, recover only exact partial state, fail closed on conflict or ambiguity, and leave every publication pull request for human review and merge.

PAT creation, scope review, rotation, revocation, and succession are human administrative operations. Agents and repository tests never receive a PAT value.

## Consequences

- **Positive:** publication has one direct credential path and no App JWT or installation-token machinery.
- **Positive:** the administrative grant is limited to one bot identity, one resource owner, one repository, and the two required write permissions.
- **Positive:** the publication credential has no Actions write authority.
- **Negative:** unlike a one-hour App installation token, the fine-grained PAT remains valid until its configured expiry or revocation. Human maintainers must manage expiry and rotation.
- **Negative:** repository code cannot prove the PAT's configured owner, repository selection, or permissions without using the credential. Those properties require out-of-band administrative review.
- **Neutral:** the upstream trigger PAT is part of the other repository's boundary and is not stored or consumed here.
- **Neutral:** ADR-0001 remains the authority for evidence, signing, and publication transaction invariants; this record replaces only its adopted GitHub App authentication mechanism.

## Alternatives Considered

### Keep the dedicated GitHub App

Rejected because the approved design standardizes the cross-repository transaction on two separately scoped PATs and no longer requires App lifecycle or token-minting machinery.

### Use the workflow `GITHUB_TOKEN`

Rejected because the publication credential must be a separately owned fine-grained PAT with explicit bot identity and repository scope, independent of workflow-token policy.

### Validate PAT scope through the GitHub API before publication

Rejected because that would require testing the production credential and could add disclosure or logging paths. Scope, ownership, expiry, and rotation remain protected administrative controls.

### Keep `CATALOGUE_SIGNING_ENABLED` as an activation variable

Rejected because the approved design requires it to remain absent. Protected-environment policy and trusted default-branch provenance remain the activation controls.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
