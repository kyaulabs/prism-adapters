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

## Publication commit-signing custody

Publication commits use the separate OpenPGP identity
`kyaulabs-bot <actions@kyaulabs.com>`. The GitHub account keeps that email
verified and registers the public key with primary fingerprint
`646340DAD3387E48F047B5C049659B98769C17D6` and Ed25519 signing-subkey
fingerprint `0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE`. Production requires GnuPG
`>=2.2.0 <3.0.0` and the reviewed public export in the repository.

The OpenPGP certification key remains offline. Human maintainers keep the
encrypted certification key, encrypted secret signing-subkey export, and
recovery public copy in an owner-restricted directory outside every repository
worktree. The passphrase is protected separately, and a genuinely offline
recovery copy remains available. The directory's absolute path is included in
`PRISM_SENSITIVE_PATHS` before agent sessions. Agents never inspect, generate,
copy, encode, or operate on the external custody directory or its contents.

The protected `catalogue-signing` environment stores only the encrypted secret
signing-subkey export and passphrase under
`CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY` and
`CATALOGUE_COMMIT_SIGNING_PASSPHRASE`. The publication step writes them to
owner-only runner-private files under an isolated GnuPG home, unsets both raw
environment values, and removes all state on every exit path. The commit-signing
boundary does not reuse the catalogue signing key; catalogue signing,
publication commit signing, and PAT authorization have independent custody and
exposure responses.

Suspected commit-signing exposure disables `CATALOGUE_SIGNING_ENABLED`, removes
protected-environment access, revokes the registered GitHub GPG key, and reviews
repository, environment, workflow, and audit-log access. A maintainer uses the
offline certification authority to create a replacement signing subkey,
registers its public key, updates the reviewed public export and fingerprints,
re-provisions both commit-signing secrets, and completes synthetic and protected
readiness checks before publication resumes. Existing GitHub verification
records remain historical evidence; rotation never rewrites prior commits.

## Publication PAT custody

Catalogue publication uses the environment-scoped secret
`CATALOGUE_PUBLICATION_TOKEN`. It contains a fine-grained PAT owned by
`kyaulabs-bot`, with resource owner `kyaulabs`, repository access limited to
only `kyaulabs/prism-adapters`, and only Contents write and Pull Requests write
permissions. It has no Actions write permission. The workflow keeps
`GITHUB_TOKEN` read-only.

The protected publication step receives the PAT only after evidence validation,
synthetic-key tests, production signing, and reverification. Code treats its
format as opaque and passes it only in the authorization header for the fixed
repository API. It never enters arguments, files, logs, outputs, summaries,
artifacts, caches, tests, fixtures, local commands, or agent context.

Human administrators review the bot owner, resource owner, selected repository,
permissions, expiry, and audit log out of band. Rotation and succession require
an explicit custody handoff. Suspected publication PAT exposure stops protected
environment access, revokes and replaces the PAT, reviews repository and
environment administration plus the GitHub audit log, and reruns synthetic and
protected readiness checks before publication resumes. This response remains
separate from the Ed25519 catalogue signing-key response. Suspected exposure
still requires Core trust-root rotation before the catalogue key is replaced.

## Activation and recovery

The repository Actions variable `CATALOGUE_SIGNING_ENABLED` records the human
activation decision. The protected job and protected signing runner both
require the exact string `true`; missing, false, case-variant,
whitespace-padded, or malformed values fail closed before signing or
publication. The workflow passes a fixed `true` marker to the runner only
after the job-level guard succeeds.

The activation variable supplements rather than replaces protected environment
deployment policy and trusted default-branch runner checks. Human maintainers
review the environment, five secrets, deployment policy, workflow, log
retention, and offline recovery custody before setting it. Removing the
variable disables protected signing and publication while leaving synthetic
validation available.

GitHub secret values cannot be retrieved after storage. Human maintainers keep
offline recovery copies of the encrypted PKCS#8 catalogue key and OpenPGP
commit-signing material, with their passphrases protected separately. Recovery
re-provisions the four signing environment secrets from those sources; it does
not extract values from GitHub. The publication PAT is rotated or replaced
through GitHub's administrative interface without exposing its value to
repository code or agents. Maintainer succession requires an explicit
out-of-band custody handoff plus a review of repository and environment
administrator access.

Loss of either catalogue-signing GitHub copy with usable offline custody
requires re-provisioning. Loss without usable offline custody follows the same
process as suspected exposure: disable signing, release a Prism Core trust-root
rotation, wait for that release to propagate, replace both protected-environment
secrets, and only then resume production signing. The catalogue cannot revoke
its own signing key. Loss of a commit-signing GitHub copy follows the separate
OpenPGP re-provisioning or rotation procedure above.

## Reports and exposure response

Report suspected catalogue-signing, commit-signing, or publication credential
exposure, catalogue equivocation, rollback, publisher path bypasses, or
signature-validation failures privately to the KYAULabs maintainer. Do not
include private-key bytes,
credential paths, passphrases, or live secret material. Demonstrate path issues
with synthetic keys and non-credential sentinels only.

Suspected signing-key exposure stops publication and requires a Prism Core
trust-root rotation before the replacement private key is installed or used.
Suspected publication PAT exposure revokes that credential and blocks protected
environment access until its replacement scope and custody are reviewed. Agents
remain forbidden from reading, receiving, displaying, copying, encoding, or
operating on any production credential value.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
