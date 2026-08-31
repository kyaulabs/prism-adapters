# Prism adapter catalogue

This public repository publishes the signed adapter catalogue consumed by
strict-empty Prism `/setup`:

```text
https://raw.githubusercontent.com/kyaulabs/prism-adapters/main/catalogue.json
```

The repository contains adapter release policy, the production public key, the
signed public envelope, and a local publisher. It never contains the production
private signing key.

## Requirements

- Linux with mounted `/proc` descriptor paths
- Node.js 22.19 or newer
- npm
- the committed `adapter-catalogue-public.pem`
- a dedicated encrypted PKCS#8 Ed25519 private key with an offline recovery copy
- a separately protected signing-key passphrase
- a `catalogue-signing` GitHub Actions environment restricted to `main`
- permission to read Prism evidence from the public GitHub API
- permission to read the public npm registry during preparation

The trusted public-key fingerprint is:

```text
74679d283825c4e6048efdfd1c96cdcd688ce5e12915fcc13a8547c3443c1e34
```

## Prepare a release update

Use the stable Prism version and immutable merge commit from the release trigger:

```bash
npm test
npm run catalogue:check-key
npm run catalogue:prepare-release -- <stable-version> <immutable-commit>
```

These two values are trigger hints, not catalogue authority. The publisher reads
only `https://api.github.com/repos/kyaulabs/prism` and independently verifies the
stable Release, direct release tag, merge commit, package tag, closed release
declaration, and release-managed package manifest. It then reads exact package
metadata only from `https://registry.npmjs.org`.

Preparation starts from the signature-verified current catalogue, preserves its
unrelated releases and statuses, and adds or replaces only the exact validated
release. It revalidates every exact npm release before generating
`catalogue-source.json` and `.publisher/payload.json`. The generated source is a
review artifact, not hand-authored compatibility or package authority.

npm availability receives at most three attempts with fixed one-second delays
and a 10-second timeout per attempt, bounding preparation to 32 seconds. A
redirect, oversized response, prerelease, mutable ref, unknown field, mismatch,
or exhausted retry writes no prepared payload and performs no signing or Git
mutation.

## Prepare a renewal

Renewal preserves the complete verified release set and refreshes only exact npm
evidence and the six-day validity window:

```bash
npm test
npm run catalogue:check-key
npm run catalogue:prepare-renewal
```

Both preparation modes require an existing verified catalogue and derive exactly
its next sequence. Expiry is tolerated only for sequence recovery. Neither mode
requests or uses signing-key material.

## Protected production signing

Production signing runs only in `.github/workflows/catalogue-signing.yml` on
trusted `main`. The runner-only command takes no arguments:

```bash
npm run catalogue:sign-protected
```

It rejects local execution, pull requests, reusable workflows, non-`main`
refs, dispatch-selected code, and debug runners before reading signing files.
It requires an encrypted PKCS#8 Ed25519 key, matches the committed Core SPKI
fingerprint and key ID, signs the exact prepared payload
bytes, reverifies the envelope, and removes runner-private secret files on
success or failure.

Human administrators create the `catalogue-signing` environment, restrict its
deployment branches to `main`, and add separate environment secrets named
`CATALOGUE_SIGNING_PRIVATE_KEY`, `CATALOGUE_SIGNING_PASSPHRASE`, and
`CATALOGUE_PUBLICATION_TOKEN`.

The protected job remains disabled unless the repository Actions variable
`CATALOGUE_SIGNING_ENABLED` has the exact value `true`. Leave the variable
absent until maintainers have reviewed the environment, deployment policy,
credential custody, log retention, workflow, and offline recovery readiness.
Removing the variable disables signing and publication without disabling
synthetic validation.

The publication secret is a fine-grained PAT owned by `kyaulabs-bot`, with
resource owner `kyaulabs`. Limit access to only `kyaulabs/prism-adapters`.
Grant Contents write and Pull Requests write only;
it has no Actions write permission. Workflow `GITHUB_TOKEN` permissions remain
read-only.

The protected publication command receives the PAT only as an opaque
environment value after signing and reverification. It does not write the value
to a file or include it in arguments, logs, outputs, summaries, artifacts, or
caches. Human administrators review the environment, credential scope,
workflow, and retention policy before allowing production runs.

GitHub cannot reveal stored secret values. Keep an offline encrypted-key
recovery copy and protect the passphrase separately. Re-provision lost GitHub
copies from those sources. A successor receives repository/environment
administration and signing custody through an explicit out-of-band handoff.
See `SECURITY.md` for exposure and Core-first rotation procedures.

## Automated publication

A repository dispatch after a stable Prism release, a daily schedule with a
verified three-day renewal gate, and explicit manual recovery all enter the
same non-cancelling transaction. Each run validates the trigger and public
evidence with:

```bash
npm run catalogue:prepare-trigger
```

The protected job recomputes that evidence, signs and reverifies the exact
payload, then invokes the runner-only publication command:

```bash
npm run catalogue:publish-protected
```

The command passes the opaque protected publication credential only to the fixed
repository API, rechecks remote `main`, and creates one immutable
`catalogue/sequence-<n>` branch plus one pull request. Exact partial state is
idempotent or recoverable;
a stale base, different bytes, invalid signature, conflicting sequence, or
another open publication pull request fails closed.

Manual recovery accepts `renewal` or `release`. Release recovery also requires
the stable version and immutable Prism merge commit. It cannot supply sequence,
branch, package, compatibility, registry, or payload authority.

## Verify and publish

After a human merges a publication pull request to `main`, verify HTTP `200` at
the fixed raw catalogue URL and run strict-empty Prism `/setup`. Adapter
discovery must report `CATALOGUE_VALID`. Automation never writes protected
`main`, updates or force-pushes a publication branch, closes a conflicting pull
request, enables auto-merge, or merges its own pull request.

## Release changes and revocations

Do not edit generated `catalogue-source.json` as authority. Adapter identity,
Core compatibility, bootstrap protocol, and `ACTIVE` or `REVOKED` status come
from the closed adapter release declaration at the immutable Prism release
commit. Package identity and version come from its validated manifest; integrity
and publication time come from exact npm metadata. The publisher never uses an
npm dist-tag such as `latest`.

Every release update and renewal recomputes the complete evidence, signing,
verification, and publication transaction from current authority.

Key rotation requires a Prism Core release that trusts the replacement public
key before this publisher signs with the replacement private key.

## Repository automation

The continuous integration workflow runs the locked Node test suite for pushes
and pull requests targeting `develop` and `main`.

After a pull request is merged into `main`, the back-merge workflow opens one
`main` to `develop` back-merge pull request when synchronization is needed.
Human review and merge remain required; automation never pushes or merges
either protected branch.

A repository administrator must enable **Settings → Actions → General →
Workflow permissions → Allow GitHub Actions to create and approve pull
requests**. This setting permits pull-request creation; the workflow itself
does not approve pull requests and receives only read-only contents plus
pull-request write authority.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
