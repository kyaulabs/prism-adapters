# Spec: Signed Catalogue Publication Commits

**Date:** 2026-08-31
**Status:** Approved
**Originating issue:** #21

## Problem Statement

The catalogue publication transaction creates an immutable sequence branch and a human-reviewed pull request through the GitHub Git Database API. Its generated commit is unsigned, so the protected `main` ruleset rejects the pull request even though the catalogue envelope itself is validly signed. The publisher also ignores GitHub's commit-verification result and can create a remote sequence ref after GitHub reports `verified: false` and `reason: unsigned`.

The repair must preserve the transaction's current authority model. The fine-grained publication PAT authorizes fixed repository writes but must not become signing authority. The catalogue Ed25519 key signs catalogue payloads and must not be reused for Git commits. Atomic absent-ref creation, immutable sequence branches, exact-state recovery, human review, required signatures, and zero bypass actors remain mandatory.

## Solution

Introduce a separate publication commit-signing identity for `kyaulabs-bot <actions@kyaulabs.com>`. An offline OpenPGP certification key controls an Ed25519 signing subkey. Only an encrypted export of that signing subkey enters the protected GitHub Actions environment. The offline certification key, signing-subkey recovery export, and offline public-key copies remain human-managed in a dedicated custody directory outside every repository worktree; the passphrase remains separately protected.

The protected publisher will construct the canonical Git commit payload, sign it through GnuPG, verify the detached signature locally against a committed public key and pinned fingerprint, and submit the signature with explicit matching author and committer fields to GitHub. It will require GitHub to report `verified: true` and `reason: valid`, with the expected payload and signature, before creating a branch or pull request.

Signing, local verification, or GitHub verification failure will fail closed. Unreachable Git objects may exist because the tree must be known before signing, but no remote sequence ref or pull request may be created.

## User Stories

1. As a catalogue consumer, I want every catalogue publication commit to satisfy the repository's verified-signature rule, so that catalogue integrity does not depend on a ruleset bypass.
2. As a maintainer, I want catalogue-envelope signing, commit signing, and publication authorization to use separate authorities, so that compromise or rotation of one does not silently grant another capability.
3. As a maintainer, I want only a signing subkey available to the protected runner, so that the certification key remains offline and can control rotation and succession.
4. As a maintainer, I want production key material stored outside Git and denied to agents, so that local custody cannot leak through commits or automated tooling.
5. As a reviewer, I want GitHub verification to complete before branch creation, so that an unsigned or invalid commit cannot become an immutable publication branch.
6. As an operator, I want signing and verification failures to leave no branch or pull request, so that recovery starts from an unambiguous remote state.
7. As an operator, I want the existing publication state machine preserved, so that races, stale bases, exact partial state, and immutable sequence branches retain their current behavior.
8. As a maintainer, I want a reviewed sequence-2 recovery procedure, so that the blocked branch and pull request remain untouched until repaired production authority is ready.
9. As a successor maintainer, I want provisioning, rotation, revocation, recovery, and custody documented, so that unattended publication does not depend on undocumented key handling.

## Implementation Decisions

### Authority and custody

- The publication commit-signing identity is distinct from the catalogue signing identity and the publication PAT.
- The trusted author and committer identity is exactly `kyaulabs-bot <actions@kyaulabs.com>`.
- `actions@kyaulabs.com` must be verified on the `kyaulabs-bot` GitHub account and included in the OpenPGP identity registered with that account.
- The OpenPGP certification key remains offline. The protected environment receives only an encrypted Ed25519 signing-subkey export and its separately stored passphrase.
- The committed public key and exact primary fingerprint `646340DAD3387E48F047B5C049659B98769C17D6` plus signing-subkey fingerprint `0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE` are public verification policy. Production refuses a private-key export whose fingerprints, signing capability, or identity do not match that policy.
- Human-managed offline material lives in a dedicated owner-restricted directory outside every repository worktree. Its absolute path is added to `PRISM_SENSITIVE_PATHS` before agent sessions and remains forbidden to agents.
- The passphrase is not stored in the custody directory or beside any key export. A genuinely offline recovery copy remains separately required.
- Production uses separate protected-environment secrets named `CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY` and `CATALOGUE_COMMIT_SIGNING_PASSPHRASE`.

### Protected signing boundary

- GnuPG `>=2.2.0 <3.0.0` is an explicit external runtime prerequisite. No npm dependency is added.
- GnuPG runs without a shell, with fixed arguments, an isolated runner-private home, bounded input and output, disabled interactive prompting, and generic secret-safe failures.
- The workflow writes the two commit-signing secret values to owner-only runner-private files, unsets their environment variables before invoking Node, and removes the files and isolated GnuPG home on every exit path.
- The signer validates the imported secret signing subkey against the committed public policy before use.
- Local detached-signature verification is mandatory before any signed commit request.

### Commit payload and GitHub verification

- One injected UTC instant, truncated to whole seconds, supplies matching author and committer dates.
- The canonical unsigned commit payload contains the GitHub-created tree SHA, the validated `main` parent SHA, the fixed identity, the timestamp, and `chore(catalogue): publish sequence <n>`.
- The GitHub create-commit request includes explicit author, committer, and ASCII-armored detached PGP signature fields matching the signed payload.
- Before any ref request, the publisher requires a valid commit SHA, `verification.verified === true`, `verification.reason === "valid"`, and returned signature and payload values equal to those submitted.
- Missing, false, non-`valid`, malformed, or mismatched verification fails closed.
- Authentication through the publication PAT remains unchanged and gains no new repository or Actions permission.

### Publication transaction

- The existing order remains blobs, tree, signed commit, GitHub verification, `main` recheck, atomic absent-ref creation, exact branch inspection, and pull-request creation.
- Existing no-update, no-force, immutable-branch, stale-base, race-recovery, exact-state, and idempotency rules remain unchanged.
- Required signatures and zero bypass actors remain enabled on protected `main`.
- Automation does not close pull requests, delete branches, push Git refs, merge, or force-update any ref.

### Recovery

- Pull request 20 and `catalogue/sequence-2` remain unchanged until the repaired code, accepted architecture record, committed public key, protected secrets, account registration, and custody documentation reach trusted `main`.
- After those prerequisites are reviewed, a human closes pull request 20 and deletes the old sequence branch.
- A human dispatches the documented release-recovery mode. The publisher recomputes authority from current evidence and the verified current catalogue, regenerates sequence 2, creates a GitHub-verified immutable commit, and opens a replacement pull request for human review.
- The recovery procedure verifies `verified: true` and `reason: valid` through GitHub before review and merge.

### Architecture records and domain context

- ADR-0005 supersedes ADR-0004's repository-local custody choice while retaining its separate OpenPGP publication commit-signing identity, signing-subkey model, and GitHub verification gate. Neither decision supersedes direct PAT authentication or explicit activation from ADR-0003.
- The project context adds the publication commit-signing identity, its protected signing boundary, and the separation among catalogue signing, commit signing, and publication authorization.
- Provisioning and security documentation cover external custody, `PRISM_SENSITIVE_PATHS`, public-key registration, protected secrets, activation, rotation, revocation, succession, failure response, and sequence-2 recovery.

## Testing Decisions

The highest seam is the public catalogue publication operation. Tests assert observable GitHub request order and effects rather than private helper calls.

- Publication-boundary tests require exact author, committer, timestamp, and signature request values.
- They require successful GitHub verification before the first ref request.
- Missing verification, false verification, every non-`valid` reason, mismatched signature or payload, and malformed responses produce zero ref and pull-request requests.
- Signing and local-verification failures also produce zero commit, ref, and pull-request requests after the failure point.
- Existing race, idempotency, stale-base, exact-state, immutable-branch, and credential-boundary tests remain in force.
- A real-GnuPG integration seam uses runtime-generated synthetic certification and signing keys in isolated temporary directories. It checks canonical payload bytes against an independently Git-produced synthetic commit, signs and verifies the payload, and exercises wrong fingerprint, wrong identity, missing signing capability, bad passphrase, malformed signature, unavailable GnuPG, and bounded process failures.
- Tests assert that errors and captured process output never contain synthetic passphrases or private-key material.
- Protected-runner tests cover absent or malformed signing state and prove that publication receives only validated signing capability.
- Workflow tests prove that commit-signing secrets appear only in the protected publication step, tracing is disabled, files are owner-only, environment values are unset, no secret-bearing output or artifact path exists, and cleanup runs unconditionally.
- Documentation tests cover GnuPG, external custody, agent denial, provisioning, rotation, and recovery requirements.
- The complete native Node test suite and changed-file coverage gate must pass.

## Out of Scope

- Weakening the protected `main` ruleset or adding bypass actors.
- Reusing the catalogue Ed25519 key for Git commits.
- Expanding the publication PAT or replacing it with the workflow token.
- Adding an npm OpenPGP implementation.
- Replacing REST publication with Git push, the Contents API, or a branch-first transport.
- Automated closure, deletion, force-push, merge, or recovery mutation of pull request 20 or `catalogue/sequence-2`.
- Changing catalogue sequence derivation, catalogue signature format, release evidence, or deterministic catalogue source behavior.
- Agent access to, generation of, or operation on production or offline key material.

## Further Notes

- GitHub's Git Database create-commit endpoint accepts an ASCII-armored detached PGP signature over the canonical commit payload and returns a verification object. `valid` is the only accepted verification reason for this transaction: <https://docs.github.com/en/rest/git/commits>.
- The production public key is safe to review and commit. No private-key bytes, passphrases, protected secret values, or contents of the external custody directory may enter agent context, tests, fixtures, logs, outputs, summaries, artifacts, caches, or Git history.
- The issue's production evidence remains the blocked unsigned commit `a9d8fa3f86d324e842b000696d01e002d6cf71a0` in pull request 20.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
