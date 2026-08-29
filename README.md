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
- a dedicated Ed25519 private signing key held outside every repository
- permission to read Prism evidence from the public GitHub API
- permission to read the public npm registry during preparation
- permission to push the signed publication branch as a human

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

## Sign as the human key custodian

The coding agent must stop here. In an interactive terminal, the human key
custodian runs:

```bash
npm run catalogue:sign
```

The command prompts for the private-key path. Absolute paths, relative paths,
and leading `~/`, `$HOME/`, or `${HOME}/` spellings are accepted; no other
shell expansion occurs. The key must be a regular, non-symlink Ed25519 private
key outside this repository. Encrypted PKCS#8 keys trigger a second hidden
passphrase prompt. Preparation prints the SHA-256 digest of the exact payload.
Before requesting the key, signing prints the current digest and requires the
custodian to confirm it matches the preparation output. The command then
derives the public key, compares it with `adapter-catalogue-public.pem`, signs
the exact prepared payload bytes, verifies the resulting envelope, and
atomically writes `catalogue.json`.

Never put the private key, its path, or its passphrase in this repository,
another repository, CI, an `.env` file, a command argument, an environment
variable, a fixture, a log, an issue, or chat.

## Verify and publish

After the human signing command succeeds, the agent may resume:

```bash
npm run catalogue:verify
npm test
git diff -- catalogue.json
```

The diff is public signed data. Confirm that its sequence increased and its
expiry is six days after issue. Commit it with the structured Prism commit
workflow. The human pushes the branch and merges the pull request.

After `main` updates, run:

```bash
curl --fail --silent --show-error --output /dev/null \
  --write-out '%{http_code}\n' \
  https://raw.githubusercontent.com/kyaulabs/prism-adapters/main/catalogue.json
```

Expected output is `200`. Then run strict-empty Prism `/setup` in the intended
new project and confirm adapter discovery reports `CATALOGUE_VALID`.

## Release changes and revocations

Do not edit generated `catalogue-source.json` as authority. Adapter identity,
Core compatibility, bootstrap protocol, and `ACTIVE` or `REVOKED` status come
from the closed adapter release declaration at the immutable Prism release
commit. Package identity and version come from its validated manifest; integrity
and publication time come from exact npm metadata. The publisher never uses an
npm dist-tag such as `latest`.

Re-run the complete evidence preparation, human sign, verify, review, and publish
sequence for every release update or renewal.

Key rotation requires a Prism Core release that trusts the replacement public
key before this publisher signs with the replacement private key.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
