# Security policy

## Production signing custody

Production catalogue signing runs only in the trusted `main` workflow job that
uses the `catalogue-signing` protected environment. The encrypted PKCS#8
Ed25519 key and passphrase are separate environment-scoped GitHub Actions secrets.
They are named `CATALOGUE_SIGNING_PRIVATE_KEY` and
`CATALOGUE_SIGNING_PASSPHRASE`.

The protected job receives those secrets only after unprivileged validation and
synthetic-key tests pass. Pull requests, reusable workflows, non-`main` refs,
unprivileged jobs, local commands, tests, fixtures, agents, caches, artifacts,
step outputs, summaries, and debug logs never receive production signing
material. GitHub masks configured secret values; the signing step also disables
shell tracing and writes the values only to owner-readable runner-private files
that are removed on every exit path.

Repository and environment administrators are part of the production signing
trust base. Environment deployment policy must allow only `main`. Required
environment reviewers are not used because they would prevent unattended
renewal. Before activation, set and verify Actions log retention at seven days
and confirm that Actions runner and step debug logging are disabled.

## Activation and recovery

`CATALOGUE_SIGNING_ENABLED` is a non-secret repository-level Actions variable.
A human maintainer sets it under **Repository Settings → Secrets and variables
→ Actions → Variables** only after the environment, both secrets, deployment
policy, workflow, and log retention have been reviewed. Disabling or removing
the variable stops the protected signing job before it enters the environment.

GitHub secret values cannot be retrieved after storage. Human maintainers keep
an offline recovery copy of the encrypted PKCS#8 key and protect its passphrase
separately. Recovery re-provisions the two environment secrets from those
sources; it does not extract values from GitHub. Maintainer succession requires
an explicit out-of-band custody handoff plus a review of repository and
environment administrator access.

Loss of either GitHub copy with usable offline custody requires re-provisioning.
Loss without usable offline custody follows the same process as suspected
exposure: disable signing, release a Prism Core trust-root rotation, wait for
that release to propagate, replace both protected-environment secrets, and only
then resume production signing. The catalogue cannot revoke its own signing
key.

## Reports and exposure response

Report suspected key exposure, catalogue equivocation, rollback, publisher path
bypasses, or signature-validation failures privately to the KYAULabs
maintainer. Do not include private-key bytes, credential paths, passphrases, or
live secret material. Demonstrate path issues with synthetic keys only.

Suspected exposure immediately disables `CATALOGUE_SIGNING_ENABLED` and stops
publication. Recovery requires a Prism Core trust-root rotation before the
replacement private key is installed or used. Agents remain forbidden from
reading, receiving, displaying, copying, encoding, or operating on any
production credential value.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
