# Signed Catalogue Publication Commits Implementation Plan

> **For the executing agent:** Implement this plan task-by-task by loading the
> `executing-plans` and `tdd` skills. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task follows Red → Green → Refactor inline.

**Goal:** Sign every automated catalogue publication commit with the separately custodied OpenPGP identity and require valid GitHub verification before creating a branch or pull request.

**Architecture:** A dedicated commit-signing module constructs canonical Git commit payloads and invokes GnuPG through a bounded, shell-free process boundary. The existing GitHub publication transaction accepts the resulting detached signature, validates GitHub's response before ref creation, and retains the current state machine. Protected workflow code stages the signing-subkey export and passphrase in an isolated runner-private directory and removes them on every exit path.

**Tech Stack:** Node.js `>=22.19.0`, native ESM, Node test runner, GnuPG `>=2.2.0 <3.0.0`, GitHub REST Git Database API, GitHub Actions.

**Originating issue:** #21

## Global constraints

- Use `kyaulabs-bot <actions@kyaulabs.com>` for both commit author and committer.
- Trust primary fingerprint `646340DAD3387E48F047B5C049659B98769C17D6` and signing-subkey fingerprint `0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE`.
- Trust public export SHA-256 `aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3`.
- Keep every private key, passphrase, recovery copy, and external custody path outside agent context and repository paths.
- Keep the external custody directory in `PRISM_SENSITIVE_PATHS`; agents access only `publication-commit-signing-public.asc`.
- Add no npm dependency. Use `/usr/bin/gpg` without a shell and with a minimal child environment.
- Preserve required signatures, zero bypass actors, direct PAT scope, explicit activation, atomic absent-ref creation, no-force behavior, sequence immutability, exact recovery, and human merge.
- A signing or verification failure may leave unreachable Git objects but must create no branch or pull request.
- Tests use runtime-generated synthetic OpenPGP material only.
- Every new `.js` file receives the required RCS header and vim modeline.
- Native focused tests use `node --test <test-file>`; the full coverage command is `node --test --experimental-test-coverage`.

## File structure

- `src/commit-signing-policy.js` — immutable public identity, fingerprint, and export-digest policy.
- `src/commit-signing.js` — canonical payload construction, bounded GnuPG process boundary, key-policy checks, signing, and local verification.
- `test/commit-signing-policy.test.js` — committed production public-export policy.
- `test/commit-signing.test.js` — synthetic real-GnuPG signing and failure behavior.
- `test/helpers/openpgp.js` — runtime-only synthetic OpenPGP fixture generation under temporary directories.
- `src/github-publication.js` — requests signed commits and rejects invalid GitHub verification before refs.
- `test/github-publication.test.js` — request order, verification matrix, and zero-ref/PR failure assertions.
- `src/publication-runner.js` — supplies fixed signing paths and cleans the runner-private commit-signing directory.
- `test/publication-runner.test.js` — fixed-path, cleanup, and secret-boundary assertions.
- `.github/workflows/catalogue-signing.yml` — stages the two new environment secrets only for protected publication.
- `test/workflow.test.js` — workflow secret count, isolation, unsetting, and cleanup assertions.
- `README.md`, `SECURITY.md`, `test/documentation.test.js` — GnuPG, external custody, provisioning, rotation, exposure, and sequence-2 recovery.
- `CONTEXT.md`, `adr/0004-use-separate-openpgp-publication-commit-signing.md`, `adr/0005-keep-publication-commit-signing-custody-outside-the-repository.md`, `docs/specs/2026-08-31-signed-catalogue-publication-commits-spec.md` — approved domain and architecture records.

---

### Task 1: Pin the production public commit-signing policy

**Files:**
- Create: `src/commit-signing-policy.js`
- Create: `test/commit-signing-policy.test.js`
- Add: `publication-commit-signing-public.asc`
- Modify: `CONTEXT.md`
- Add: `adr/0004-use-separate-openpgp-publication-commit-signing.md`
- Add: `adr/0005-keep-publication-commit-signing-custody-outside-the-repository.md`
- Add: `docs/specs/2026-08-31-signed-catalogue-publication-commits-spec.md`
- Add: `docs/plans/2026-08-31-signed-catalogue-publication-commits.md`

**Interfaces:**
- Consumes: the human-provisioned public-only OpenPGP export.
- Produces: `COMMIT_SIGNING_POLICY` and `verifyCommitSigningPublicExport({filePath})` for the signing module.

- [x] **Step 1: Write the failing public-policy test**

Create `test/commit-signing-policy.test.js` with assertions that the committed export is a bounded regular file, has SHA-256 `aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3`, and that the exported policy contains the exact identity and fingerprints:

```javascript
// $KYAULabs: commit-signing-policy.test.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    COMMIT_SIGNING_POLICY,
    verifyCommitSigningPublicExport,
} from '../src/commit-signing-policy.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicKeyPath = path.join(root, 'publication-commit-signing-public.asc');

test('pins the production publication commit-signing identity', async () => {
    assert.deepEqual(COMMIT_SIGNING_POLICY, Object.freeze({
        name: 'kyaulabs-bot',
        email: 'actions@kyaulabs.com',
        primaryFingerprint: '646340DAD3387E48F047B5C049659B98769C17D6',
        signingFingerprint: '0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE',
        publicExportSha256: 'aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3',
    }));
    await verifyCommitSigningPublicExport({filePath: publicKeyPath});
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [x] **Step 2: Run the policy test to verify Red**

Run: `node --test test/commit-signing-policy.test.js`

Expected: FAIL because `src/commit-signing-policy.js` does not exist.

- [x] **Step 3: Add the minimal policy module**

Create `src/commit-signing-policy.js`:

```javascript
// $KYAULabs: commit-signing-policy.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import {createHash} from 'node:crypto';

import {readBoundedRegularFile} from './safe-file.js';

export const COMMIT_SIGNING_POLICY = Object.freeze({
    name: 'kyaulabs-bot',
    email: 'actions@kyaulabs.com',
    primaryFingerprint: '646340DAD3387E48F047B5C049659B98769C17D6',
    signingFingerprint: '0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE',
    publicExportSha256: 'aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3',
});

export async function verifyCommitSigningPublicExport({filePath}) {
    const bytes = await readBoundedRegularFile({filePath, maximum: 65_536});
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== COMMIT_SIGNING_POLICY.publicExportSha256 ||
        !bytes.subarray(0, 36).equals(Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----'))) {
        throw new Error('publication commit-signing public key is not trusted');
    }
    return bytes;
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

Refactor the armor-prefix check to use the exact prefix length rather than a magic slice length before Green.

- [x] **Step 4: Run the policy test and full existing suite**

Run: `node --test test/commit-signing-policy.test.js`

Expected: PASS.

Run: `npm test`

Expected: all existing tests plus the policy test PASS.

- [x] **Step 5: Create the policy and architecture commit**

Stage only the files listed in this task, load `conventional-commits`, and run this as the sole tool call in its assistant batch:

```bash
prism-tool commit create --type fix --scope security --subject "pin publication commit-signing policy" --refs 21
```

---

### Task 2: Sign canonical commit payloads through bounded GnuPG

**Files:**
- Create: `src/commit-signing.js`
- Create: `test/commit-signing.test.js`
- Create: `test/helpers/openpgp.js`

**Interfaces:**
- Consumes: `COMMIT_SIGNING_POLICY`, the public export path, owner-only encrypted signing-subkey and passphrase files, an isolated home path, commit tree/parent/message/time, and an injectable `spawnImpl`.
- Produces: `canonicalCommit({treeSha, parentSha, message, now, policy})` and `signPublicationCommit(options)`, returning `{author, committer, payload, signature}`.

- [x] **Step 1: Write failing canonical-payload tests**

Add tests that freeze `now` at `2026-08-31T12:34:56.789Z` and require this exact payload, with no trailing newline:

```text
tree 4444444444444444444444444444444444444444
parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
author kyaulabs-bot <actions@kyaulabs.com> 1788179696 +0000
committer kyaulabs-bot <actions@kyaulabs.com> 1788179696 +0000

chore(catalogue): publish sequence 8
```

The returned API date for author and committer must be `2026-08-31T12:34:56.000Z`. Add rejection cases for malformed SHAs, multiline messages, invalid dates, and altered policy identity.

- [x] **Step 2: Run the canonical test to verify Red**

Run: `node --test test/commit-signing.test.js`

Expected: FAIL because `src/commit-signing.js` does not exist.

- [x] **Step 3: Implement canonical payload construction**

Use this public shape:

```javascript
export function canonicalCommit({treeSha, parentSha, message, now, policy = COMMIT_SIGNING_POLICY}) {
    const instant = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const epoch = Math.floor(instant.getTime() / 1000);
    const identity = `${policy.name} <${policy.email}>`;
    const payload = [
        `tree ${treeSha}`,
        `parent ${parentSha}`,
        `author ${identity} ${epoch} +0000`,
        `committer ${identity} ${epoch} +0000`,
        '',
        message,
    ].join('\n');
    return Object.freeze({
        author: Object.freeze({name: policy.name, email: policy.email, date: instant.toISOString()}),
        committer: Object.freeze({name: policy.name, email: policy.email, date: instant.toISOString()}),
        payload,
    });
}
```

Validate SHA, message, date, name, and email before constructing bytes. Reject carriage returns, line feeds, NULs, non-UTC/invalid instants, and any production-policy mutation.

- [x] **Step 4: Add the synthetic GnuPG fixture and failing signing tests**

`test/helpers/openpgp.js` must create a temporary `GNUPGHOME`, generate a synthetic Ed25519 certification key plus one signing subkey, export public and encrypted secret-subkey material, write an owner-only passphrase file, and return dynamic fingerprints and paths. It invokes `/usr/bin/gpg` with argument arrays and sends its synthetic passphrase through file descriptor 3.

Add tests for:

- successful detached signing and local verification;
- production public-export digest mismatch;
- primary fingerprint mismatch;
- signing-subkey fingerprint mismatch;
- wrong UID email;
- absent signing capability;
- group-readable private or passphrase file;
- bad passphrase;
- malformed armored signature;
- child timeout, non-zero exit, oversized stdout, and oversized stderr;
- child environment containing only `HOME`, `GNUPGHOME`, `LANG`, and `LC_ALL`;
- no synthetic passphrase or private-key bytes in errors or captured output.

- [x] **Step 5: Implement the bounded GnuPG boundary**

`signPublicationCommit()` must:

1. verify the public export digest;
2. read the private export and passphrase with `readBoundedPrivateFile()` and zero both buffers in `finally`;
3. create a fresh owner-only GnuPG home outside the repository;
4. import the public export and encrypted secret-subkey export through stdin;
5. inspect `--with-colons --with-subkey-fingerprint --list-keys` and `--list-secret-keys` output for the exact UID and both fingerprints;
6. construct canonical payload bytes;
7. call GnuPG with `--armor --detach-sign --local-user <signing-fingerprint>! --digest-algo SHA256`, passing the passphrase on descriptor 3;
8. write the payload and signature to fixed owner-only files inside the isolated home using exclusive creation, verify them with `--verify <signature-path> <payload-path>`, and never place either path outside that home;
9. return the author, committer, payload string, and armored signature;
10. remove the isolated home and both verification files in `finally`.

The child process wrapper uses `/usr/bin/gpg`, `shell: false`, a 10-second timer, 65,536-byte stdout/stderr bounds, and this exact child environment:

```javascript
{
    HOME: homePath,
    GNUPGHOME: homePath,
    LANG: 'C',
    LC_ALL: 'C',
}
```

All failure paths throw `new Error('publication commit signing failed')` without child output or secret-bearing causes.

- [x] **Step 6: Run focused and complete signing tests**

Run: `node --test test/commit-signing.test.js`

Expected: PASS with real synthetic GnuPG signing.

Run: `node --test test/commit-signing-policy.test.js test/commit-signing.test.js`

Expected: PASS.

- [x] **Step 7: Create the signing-boundary commit**

Stage only the files listed in this task, load `conventional-commits`, and run this as the sole tool call in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "sign canonical catalogue commits" --refs 21
```

---

### Task 3: Require valid GitHub verification before ref creation

**Files:**
- Modify: `src/github-publication.js`
- Modify: `test/github-publication.test.js`

**Interfaces:**
- Consumes: `signPublicationCommit({treeSha, parentSha, message, now, ...commitSigning})` and fixed commit-signing paths supplied by the protected runner.
- Produces: a signed create-commit request whose response must prove valid GitHub verification before the existing `main` recheck and ref request.

- [x] **Step 1: Add a failing verified-commit creation test**

Extend the creation fixture so the injected signer returns:

```javascript
{
    author: {name: 'kyaulabs-bot', email: 'actions@kyaulabs.com', date: '2026-08-31T12:34:56.000Z'},
    committer: {name: 'kyaulabs-bot', email: 'actions@kyaulabs.com', date: '2026-08-31T12:34:56.000Z'},
    payload: 'synthetic canonical commit payload',
    signature: '-----BEGIN PGP SIGNATURE-----\nsynthetic\n-----END PGP SIGNATURE-----\n',
}
```

The fake create-commit response returns the same signature and payload with `verified: true` and `reason: valid`. Assert the request body contains exact message, tree, parents, author, committer, and signature fields and that the first `/git/refs` request occurs after the verified response.

- [x] **Step 2: Run the publication test to verify Red**

Run: `node --test test/github-publication.test.js`

Expected: FAIL because the create-commit request has no signature, author, or committer.

- [x] **Step 3: Integrate signing into branch creation**

Change `createSequenceBranch()` to call the injected signer after tree creation and before `/git/commits`. Send:

```javascript
body: {
    message,
    tree: treeSha,
    parents: [intent.baseSha],
    author: signed.author,
    committer: signed.committer,
    signature: signed.signature,
}
```

Validate the response before reading its SHA:

```javascript
const verification = commit.value?.verification;
if (verification?.verified !== true || verification.reason !== 'valid' ||
    verification.signature !== signed.signature ||
    verification.payload !== signed.payload) {
    throw publicationInvalid();
}
```

Only after this gate may code recheck `main` and call `/git/refs`.

- [x] **Step 4: Add the complete failure matrix**

Use table-driven tests for absent verification, false verification, `unsigned`, `unknown_key`, `bad_email`, `unverified_email`, `malformed_signature`, `invalid`, `gpgverify_error`, `gpgverify_unavailable`, mismatched signature, mismatched payload, and malformed commit SHA. For each case, collect request paths and assert no `/git/refs` or `/pulls` POST occurs.

Add a signer-rejection test asserting no `/git/commits`, `/git/refs`, or `/pulls` POST occurs after the signing failure. Keep blob and tree creation assertions explicit because those unreferenced objects are permitted.

Update idempotent existing-state tests to prove the signer is never called when no branch creation is needed.

- [x] **Step 5: Run focused publication tests**

Run: `node --test test/github-publication.test.js`

Expected: PASS.

Run: `node --test test/publication-state.test.js test/github-publication.test.js`

Expected: PASS with all state-machine behavior preserved.

- [x] **Step 6: Create the GitHub verification commit**

Stage only the files listed in this task, load `conventional-commits`, and run this as the sole tool call in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "require valid GitHub commit verification" --refs 21
```

---

### Task 4: Isolate commit-signing credentials in protected publication

**Files:**
- Modify: `src/publication-runner.js`
- Modify: `test/publication-runner.test.js`
- Modify: `.github/workflows/catalogue-signing.yml`
- Modify: `test/workflow.test.js`

**Interfaces:**
- Consumes: fixed runner-private files `private.asc` and `passphrase` under `${RUNNER_TEMP}/prism-publication-commit-signing/` plus the committed public export.
- Produces: `commitSigning` options passed to `publishCatalogueCandidate()` and unconditional cleanup of the complete runner-private directory.

- [ ] **Step 1: Write failing protected-runner path and cleanup tests**

Extend the publication-runner fixture with owner-only synthetic files under:

```text
<RUNNER_TEMP>/prism-publication-commit-signing/private.asc
<RUNNER_TEMP>/prism-publication-commit-signing/passphrase
```

Require the injected publisher to receive:

```javascript
commitSigning: {
    publicKeyPath: path.join(cwd, 'publication-commit-signing-public.asc'),
    privateKeyPath: path.join(runnerTemp, 'prism-publication-commit-signing', 'private.asc'),
    passphrasePath: path.join(runnerTemp, 'prism-publication-commit-signing', 'passphrase'),
    homePath: path.join(runnerTemp, 'prism-publication-commit-signing', 'gnupg'),
}
```

Assert the directory is absent after both successful and rejected publication. Assert a relative, in-worktree, or equal-to-worktree `RUNNER_TEMP` never triggers fallback cleanup.

- [ ] **Step 2: Run the runner test to verify Red**

Run: `node --test test/publication-runner.test.js`

Expected: FAIL because no commit-signing paths are passed and no directory is cleaned.

- [ ] **Step 3: Add fixed paths and defensive cleanup**

Derive the signing directory only after existing trusted-runner checks. Pass the exact object above to `publishImpl`, pass the injected `now` through for commit timestamps, and remove the signing directory in `finally` with Node's `rm({recursive: true, force: true})`. Preserve the existing generic `protected catalogue publication failed` boundary.

- [ ] **Step 4: Write failing workflow isolation tests**

Require each new secret reference to occur exactly once, only in the publication step. Require `set +x`, `umask 077`, an exit trap, owner-only directory creation, fixed filenames, environment unsetting, and the absence of outputs, summaries, artifacts, caches, command arguments containing values, or debug logging.

- [ ] **Step 5: Stage secrets in the protected workflow**

The publication step uses:

```yaml
env:
  CATALOGUE_PUBLICATION_TOKEN: ${{ secrets.CATALOGUE_PUBLICATION_TOKEN }}
  ENCRYPTED_COMMIT_SIGNING_PRIVATE_KEY: ${{ secrets.CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY }}
  COMMIT_SIGNING_PASSPHRASE: ${{ secrets.CATALOGUE_COMMIT_SIGNING_PASSPHRASE }}
```

Its shell body creates `${RUNNER_TEMP}/prism-publication-commit-signing` with mode `700`, writes `private.asc` and `passphrase` under `umask 077`, unsets both raw signing environment variables, invokes `npm run catalogue:publish-protected`, and removes the directory through an `EXIT HUP INT TERM` trap. The always-run cleanup step also removes this directory. Keep workflow `GITHUB_TOKEN` permissions read-only.

- [ ] **Step 6: Run runner and workflow tests**

Run: `node --test test/publication-runner.test.js test/workflow.test.js`

Expected: PASS.

Run: `npm test`

Expected: complete suite PASS.

- [ ] **Step 7: Create the protected workflow commit**

Stage only the files listed in this task, load `conventional-commits`, and run this as the sole tool call in its assistant batch:

```bash
prism-tool commit create --type fix --scope actions --subject "isolate publication commit-signing credentials" --refs 21
```

---

### Task 5: Document custody, provisioning, exposure response, and sequence-2 recovery

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `test/documentation.test.js`

**Interfaces:**
- Consumes: accepted ADR-0005 and the protected workflow behavior.
- Produces: human provisioning, rotation, revocation, succession, activation, and recovery instructions that never expose private material to agents.

- [ ] **Step 1: Write failing documentation contract tests**

Add assertions requiring documentation to name:

- GnuPG `>=2.2.0 <3.0.0`;
- `kyaulabs-bot <actions@kyaulabs.com>`;
- both protected secret names;
- the external non-repository custody requirement;
- `PRISM_SENSITIVE_PATHS` and the agent-access prohibition;
- separate passphrase storage and genuinely offline recovery copy;
- primary and signing-subkey fingerprints;
- registration of the public key and verified email;
- independent catalogue-key, commit-key, and PAT exposure responses;
- human closure of PR 20 and deletion of `catalogue/sequence-2` only after repaired trusted `main` and custody readiness;
- manual release recovery followed by GitHub `verified: true`, `reason: valid` confirmation.

- [ ] **Step 2: Run documentation tests to verify Red**

Run: `node --test test/documentation.test.js`

Expected: FAIL because the new custody and recovery contracts are absent.

- [ ] **Step 3: Update operator and security documentation**

In `README.md`, add the public export and GnuPG to requirements; document the fixed identity, public fingerprints, two environment secrets, external custody prohibition, protected runner flow, and exact human sequence-2 recovery order.

In `SECURITY.md`, add a separate publication commit-signing custody section. State that suspected commit-key exposure disables activation, removes protected-environment access, revokes the GitHub GPG key, rotates through the offline certification authority, reviews audit and workflow access, registers the replacement public key, updates the reviewed repository policy, and re-provisions secrets before publication resumes. Keep catalogue-key Core-first rotation and PAT revocation procedures independent.

- [ ] **Step 4: Run documentation and complete verification**

Run: `node --test test/documentation.test.js`

Expected: PASS.

Run: `node --test --experimental-test-coverage`

Expected: all tests PASS; each changed source file has at least 80% line coverage.

Run: `git diff --check`

Expected: no output and exit status 0.

Run `/check` and repeat repairs plus `/check` until green.

- [ ] **Step 5: Create the terminal issue-closing commit**

Stage only the files listed in this task plus any plan-authorized verification repair, load `conventional-commits`, and run this as the sole tool call in its assistant batch:

```bash
prism-tool commit create --type docs --scope security --subject "document commit-signing custody and recovery" --fixes 21
```

---

## Final verification and handoff

- [ ] Confirm `git status --short` contains no unplanned files, debug instrumentation, generated private material, or external custody path.
- [ ] Confirm `rg -n '\[DEBUG-|PRIVATE KEY BLOCK|COMMIT_SIGNING_PASSPHRASE=' . --glob '!publication-commit-signing-public.asc'` finds no secret material or debug tags; treat expected workflow variable names as names, never values.
- [ ] Re-run `npm test` and `node --test --experimental-test-coverage`.
- [ ] Load `verification-before-completion` and verify the original unsigned-commit repro is now green: an unsigned or invalid verification response causes zero ref and PR requests.
- [ ] Hand the completed branch to `finishing-a-development-branch` for cleanup, synchronization, unlimited `/check` runs, one four-axis review, revalidation, and preparation-only `/pr`.
- [ ] Do not close PR 20, delete `catalogue/sequence-2`, dispatch production recovery, push, merge, or mutate protected branches. Those remain human operations after repaired code and custody reach trusted `main`.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
