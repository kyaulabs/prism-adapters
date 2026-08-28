# Publisher review repairs specification

**Date:** 2026-08-28
**Status:** Approved
**Applies to:** Prism adapter catalogue publisher finalization

## Purpose

Close the Blocking findings from the initial four-axis review and provide the
repository-local Semgrep configuration required to complete the SAST axis.
The repairs preserve the already signed sequence-1 catalogue bytes.

## Safe file boundary

All trust-boundary file reads in publisher source must use one shared bounded
regular-file reader. The reader must:

- open the final path once with read-only and no-follow semantics;
- fail closed when no-follow support is unavailable;
- validate the opened descriptor as a regular non-empty file;
- allocate at most `maximum + 1` bytes and reject content over `maximum` even
  when the file grows after descriptor validation;
- close the descriptor on every path; and
- expose no file contents or sensitive path in errors.

`src/public-key.js` must use the reader before PEM SPKI and fingerprint
validation. `src/cli.js` must use it for catalogue source, existing catalogue,
prepared payload, and the private signing key. Private-key repository-boundary
and key-pair checks remain unchanged.

## Hidden terminal input

The hidden passphrase reader must reject stream `error`, `end`, or premature
`close` events, remove every listener it registers, and restore the prior raw
mode before rejecting. It must not mutate buffers owned by the input stream.
The returned private secret buffer and internal scratch buffer remain zeroed by
their respective owners.

## Sequence recovery clock

Expired-envelope recovery may skip only the expiration check. Schema,
catalogue identity, sequence, issuance skew, validity interval, adapter data,
integrity, publication timestamps, and signature checks remain anchored to the
caller-supplied current clock. A future-issued envelope must be rejected even
when `allowExpired` is true. An otherwise valid expired envelope may still
supply the next sequence.

## Repository-local SAST policy

Create `.semgrep/kyaulabs.yml` with local ERROR rules scoped to publisher source
that reject:

- imports or requires of `node:child_process` or `child_process`;
- `eval`, `Function`, and dynamic import execution;
- pathname-based `readFile` or `readFileSync` calls;
- direct output of expressions named for passphrases, private keys, supplied
  paths, or resolved key paths;
- `process.env` access; and
- direct global `fetch` calls that bypass the injected fixed-origin boundary.

The ruleset must validate and scan without registry downloads, dependencies, or
network access. The security review command remains:

```bash
prism-tool run semgrep -- scan --config .semgrep/kyaulabs.yml --baseline-commit origin/develop --metrics off --disable-version-check --error
```

## Tests

Synthetic tests must prove:

- bounded regular files are returned;
- symlinks and files over the configured maximum are rejected;
- a terminal stream error rejects and restores raw mode without echo;
- a future-issued signed envelope is rejected during expired recovery;
- a valid expired signed envelope remains usable for sequence recovery; and
- the complete unit suite, Semgrep configuration validation, and diff scan pass.

No test or command may access the production private key or passphrase.

## Non-goals

- Repairing Advisory review findings
- Changing catalogue payload or envelope bytes
- Adding dependencies or remote Semgrep registry rules
- General JavaScript application rules unrelated to the publisher threat model

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
