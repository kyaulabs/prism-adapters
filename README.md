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
- permission to read the public npm registry during preparation
- permission to push the signed publication branch as a human

The trusted public-key fingerprint is:

```text
74679d283825c4e6048efdfd1c96cdcd688ce5e12915fcc13a8547c3443c1e34
```

## Prepare a publication

Review `catalogue-source.json`, then run:

```bash
npm test
npm run catalogue:check-key
npm run catalogue:prepare
```

Preparation reads only the fixed npm registry origin. It validates the exact
reviewed package version, canonical SHA-512 integrity, and publication time,
then writes `.publisher/payload.json`. It does not request or use signing-key
material.

Every preparation increments the existing verified catalogue sequence. The
first publication uses sequence 1. A payload expires six days after issuance.
Prepare and publish a replacement before expiry even when adapter releases have
not changed.

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

Edit only `catalogue-source.json`. Every release must name an exact stable npm
version, Core compatibility range, bootstrap protocol, and `ACTIVE` or
`REVOKED` status. Never use an npm dist-tag such as `latest`. Re-run the complete
prepare, human sign, verify, review, and publish sequence for every change.

Key rotation requires a Prism Core release that trusts the replacement public
key before this publisher signs with the replacement private key.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
