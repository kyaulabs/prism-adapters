# 0004. Use separate OpenPGP publication commit signing

Date: 2026-08-31

## Status

Superseded by ADR-0005

## Context

The catalogue publication transaction creates a commit through GitHub's Git Database API, atomically creates an immutable sequence branch, and opens a human-reviewed pull request. The protected `main` ruleset requires verified commit signatures and has no bypass actors. The existing transaction sends no signature with its create-commit request and ignores the returned verification object, so the generated commit is unsigned and cannot merge.

The publication PAT authenticates `kyaulabs-bot` and authorizes repository writes, but authentication is not commit signing. The catalogue Ed25519 key signs catalogue envelopes under the trust model adopted by ADR-0001. Reusing it for Git commits would collapse independent authorities and complicate exposure response, rotation, and succession. ADR-0003 retains the separately scoped PAT and exact activation gate; neither should change to repair commit verification.

GitHub's Git Database API accepts an ASCII-armored detached PGP signature over the canonical commit payload and reports whether that signature is valid. This preserves the transaction's required ordering: create an unreferenced signed commit, verify it through GitHub, then create the absent ref atomically.

## Decision

We add a separate publication commit-signing identity for `kyaulabs-bot <actions@kyaulabs.com>`.

An offline OpenPGP certification key controls an Ed25519 signing subkey. Only an encrypted secret signing-subkey export and its separately protected passphrase enter the `catalogue-signing` protected environment. The certification key does not enter GitHub Actions. The bot account must verify `actions@kyaulabs.com` and register the corresponding public OpenPGP key.

The repository commits a public-only key export and pins both the primary certificate fingerprint and the designated signing-subkey fingerprint. Protected publication rejects a secret export whose fingerprints, signing capability, or identity differ from this policy.

Human-managed encrypted certification material, encrypted signing-subkey recovery exports, and offline public-key copies live under the gitignored `.custody/publication-commit-signing/` directory. The passphrase does not live in that directory. Human operators restrict filesystem access and add the directory's absolute path to `PRISM_SENSITIVE_PATHS` before agent sessions. Agents never inspect, generate, copy, or operate on this material. Gitignore and agent denial are defense in depth rather than an operating-system security boundary; a genuinely offline recovery copy remains separately required.

The protected environment stores the signing-subkey export and passphrase as separate secrets named `CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY` and `CATALOGUE_COMMIT_SIGNING_PASSPHRASE`. The workflow writes them to owner-only runner-private files, unsets their environment values, uses an isolated GnuPG home, and removes all commit-signing state on every exit path.

GnuPG `>=2.2.0 <3.0.0` is the external signing prerequisite. It runs without a shell, with fixed arguments, bounded input and output, disabled interactive prompting, and secret-safe errors. No npm OpenPGP dependency is added.

The publisher constructs one canonical commit payload from the validated parent, GitHub-created tree, fixed author and committer identity, one UTC timestamp, and sequence commit message. It locally verifies the detached signature, sends explicit matching author, committer, and signature fields to GitHub, and requires all of the following before any ref request:

- a valid commit SHA;
- `verification.verified` equal to `true`;
- `verification.reason` equal to `valid`;
- returned signature and payload bytes equal to those submitted.

Any signing, local verification, or GitHub verification failure creates no branch or pull request. Unreachable blobs, trees, or commits may remain because Git objects must be assembled before verification. Atomic absent-ref creation, no-force behavior, immutable sequence branches, exact-state recovery, stale-base checks, human review, required signatures, and zero bypass actors remain unchanged.

Pull request 20 and `catalogue/sequence-2` remain untouched until this repair, its public key, protected secrets, registration, and recovery documentation reach trusted `main`. A human then closes the pull request, deletes the old branch, and dispatches documented release recovery. Automation recomputes and regenerates sequence 2; it does not perform the cleanup itself.

This decision extends ADR-0003. It does not supersede direct PAT authentication or explicit catalogue activation.

## Consequences

- **Positive:** generated publication commits satisfy the protected branch's verified-signature requirement without a bypass.
- **Positive:** catalogue signing, commit signing, and publication authorization remain independent authorities with separate exposure and rotation procedures.
- **Positive:** GitHub verification occurs before branch or pull-request creation.
- **Positive:** only a signing subkey is exposed to the protected runner; certification and recovery authority remain offline.
- **Positive:** the existing REST transaction retains atomic ref creation and exact recovery behavior.
- **Negative:** maintainers must provision, register, rotate, recover, and audit another signing identity and two protected secrets.
- **Negative:** GnuPG becomes an external runtime prerequisite and subprocess boundary.
- **Negative:** canonical Git payload construction must remain byte-for-byte compatible with GitHub.
- **Negative:** failed attempts may leave unreachable Git objects even though no branch or pull request exists.
- **Neutral:** the publication PAT keeps its current owner, repository selection, permissions, and custody.
- **Neutral:** the catalogue signature format and catalogue key do not change.

## Alternatives Considered

### Reuse the catalogue Ed25519 key

Rejected because GitHub's endpoint requires a PGP signature and because reuse would collapse catalogue policy authority with repository commit authority.

### Add OpenPGP.js

Rejected because a new cryptographic npm dependency would expand the publisher's supply-chain boundary. The protected runner already supports a bounded external GnuPG prerequisite.

### Build and push a signed commit with Git

Rejected because GitHub verification would occur after the push created the remote ref. Verification failure could therefore leave a branch, violating the fail-closed transaction.

### Rely on PAT or GitHub App identity

Rejected because API authentication authorizes writes but does not supply the detached commit signature required by the Git Database endpoint.

### Store a standalone primary signing key in Actions

Rejected because a signing subkey under an offline certification key gives narrower online authority and cleaner rotation and succession.

### Weaken the ruleset or add a bypass actor

Rejected because required verified signatures and zero bypass actors are security invariants, not obstacles to route around.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
