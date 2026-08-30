# 0001. Adopt Prism catalogue publication authority

Date: 2026-08-28

## Status

Accepted

## Context

Prism Core establishes reviewed adapter compatibility and release evidence, while this repository owns the signed supported-adapter catalogue. The repositories need one authority model that prevents dispatch text, local source, mutable refs, npm tags, or partial publication state from becoming signed catalogue policy.

The complete design was committed in `kyaulabs/prism` at commit `588c97a8` as `docs/specs/2026-08-28-automated-signed-adapter-catalogue-publication-spec.md`. Prism's accepted ADR-0092 defines signed compatible adapter discovery, ADR-0094 defines protected Actions signing custody, and ADR-0095 defines the cross-repository catalogue publication transaction. Prism later removed the completed specification from its working tree under its development-artifact lifecycle; the immutable commit remains the design record.

Issue #3 is one vertical slice of that architecture. It adds publisher-side release-evidence resolution and deterministic source rendering. Protected production signing, sequence-branch publication, and GitHub administration remain separate slices.

```text
Prism Release + immutable commit + declaration
                       |
                       v
              publisher evidence resolver <--- exact npm metadata
                       ^
                       |
          signature-verified current catalogue
                       |
                       v
             deterministic catalogue source
                       |
                       v
         protected signing and PR publication
                 (separate slices)
```

## Decision

We adopt the following immutable Prism records as the architecture authority for this repository:

- Prism commit `588c97a8`, `docs/specs/2026-08-28-automated-signed-adapter-catalogue-publication-spec.md`;
- Prism ADR-0092, `adr/0092-signed-compatible-adapter-discovery.md`;
- Prism ADR-0094, `adr/0094-protected-actions-catalogue-signing-custody.md`; and
- Prism ADR-0095, `adr/0095-cross-repository-catalogue-publication-transaction.md`.

This repository implements its assigned publisher responsibilities without copying caller authority across the boundary. A trigger hint may identify a stable version and immutable commit, but the publisher independently verifies the Release, commit, package tag, release-managed manifest, adapter release declaration, and exact npm metadata.

Issue #3 owns the evidence resolver and deterministic catalogue source renderer. The resolver starts from a signature-verified current catalogue, preserves unrelated releases and statuses, and either adds or replaces one exact validated release or renews the complete verified release set. Bounded retry exhaustion fails before payload preparation, signing, or Git mutation.

The local `CONTEXT.md` records the subset of upstream domain language and invariants needed by this repository. Future upstream decisions do not silently change this local authority. A conflicting or expanded upstream decision requires explicit local review and a new or superseding ADR.

## Consequences

- **Positive:** both repositories use one immutable authority model without duplicating the complete upstream design.
- **Positive:** issue #3 has a clear ownership boundary and cannot absorb signing or publication behavior accidentally.
- **Positive:** dispatch and local values remain inert hints rather than signed policy.
- **Negative:** maintainers must consult the pinned Prism commit and three upstream ADRs when changing the publisher boundary.
- **Negative:** an upstream architecture change requires explicit local reconciliation rather than automatic adoption.
- **Neutral:** Node's built-in APIs and fake boundary injection remain implementation choices unless a later decision changes the trust or dependency boundary.

## Alternatives Considered

### Copy the upstream specification and ADRs into this repository

Rejected because duplicate architecture records could drift and make authority ambiguous.

### Treat issue text as the only authority

Rejected because issue text is untrusted tracker data and does not preserve the complete accepted trust, signing, and publication decisions.

### Keep reviewed local catalogue source as compatibility authority

Rejected because local or dispatch-selected policy does not prove the reviewed Prism release declaration and can create a confused-deputy signing path.

### Follow the moving Prism development branch

Rejected because later branch changes could silently alter this repository's security boundary without local review.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
