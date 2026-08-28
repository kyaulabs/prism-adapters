# Publisher review closure specification

**Date:** 2026-08-28
**Status:** Approved

## Purpose

Close the four Blocking findings recorded at review head
`bff5022bd762703b9ad03791e591b23dc0d0fac1` without changing the signed
sequence-1 envelope.

## Requirements

1. Hidden-input cleanup must attempt raw-mode restoration, stream pause, and
   newline output independently. A failure in one operation must not skip the
   others.
2. `catalogue:prepare` must print the SHA-256 of the exact payload bytes.
   `catalogue:sign` must print the current payload SHA-256 and require an
   interactive affirmative confirmation that it matches the digest observed
   during preparation before requesting any private-key path or passphrase.
   Rejection or cancellation writes no catalogue.
3. `.publisher` must be a real repository-local directory with mode `0700`.
   Preparation must create it non-recursively when absent and reject symlinks,
   non-directories, and group/other permission bits. Signing must verify the
   same boundary before reading prepared state.
4. Core compatibility ranges must parse two stable semantic versions and
   require the lower bound to be strictly less than the upper bound.

## Tests

Use synthetic terminal streams, work directories, payloads, and keys only.
Cover cleanup failure independence, digest confirmation before key prompts,
confirmation rejection, symlinked/insecure work directories, and equal or
inverted Core ranges. The complete suite, catalogue verification, Markdown,
Semgrep, and `/check` must remain green.

## Non-goals

- Repairing recorded Advisory findings
- Cryptographic protection against an attacker who can modify the running
  signer process
- Changing `catalogue.json` bytes or adding dependencies

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
