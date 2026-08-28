# Security policy

## Private signing key

The production private signing key must never enter this repository, any other
repository, CI, package contents, setup state, logs, screenshots, issues, pull
requests, documentation, fixtures, `.env` files, or chat. Coding agents must
not read or operate on it.

Only the human key custodian runs `npm run catalogue:sign` in an interactive
terminal. The signing command accepts only a regular, non-symlink Ed25519 key
outside the repository and verifies that it matches the committed production
public key before publication. Encrypted PKCS#8 keys use a hidden passphrase
prompt; the passphrase must never enter arguments, environment variables,
files, logs, or chat. The custodian must compare the payload digest shown by
signing with the digest shown by preparation and confirm only an exact match.

## Reports

Report suspected key exposure, catalogue equivocation, rollback, publisher
path bypasses, or signature-validation failures privately to the KYAULabs
maintainer. Do not include private-key bytes, credential paths, or live secret
material in a report. Demonstrate path issues with synthetic keys only.

A suspected private-key exposure requires stopping publication and releasing a
Prism Core trust-root rotation before using a replacement signing key.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
