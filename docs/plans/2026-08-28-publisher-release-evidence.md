# Publisher Release Evidence Implementation Plan

> **For the executing agent:** Implement this plan task-by-task by loading the
> `executing-plans` and `tdd` skills. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task follows Red → Green → Refactor inline.

**Goal:** Replace reviewed local catalogue authority with independent immutable Prism and exact npm evidence resolution that renders deterministic catalogue source and fails before payload creation on any disagreement.

**Architecture:** Keep four focused modules: catalogue source policy, bounded JSON transport, npm evidence, and GitHub release evidence. The public CLI composes those modules for release updates and renewal, verifies the current signed catalogue as the preservation baseline, then writes deterministic source and a prepared payload only after every boundary succeeds.

**Tech Stack:** Node.js `>=22.19.0`, ECMAScript modules, built-in `fetch`, `AbortSignal`, `Buffer`, `crypto`, `fs/promises`, and `node:test`; no new dependencies.

**Originating issue:** #3

## Global constraints

- Authority is Prism commit `588c97a8`, its automated publication specification, upstream ADRs 0092/0094/0095, and local `adr/0001-adopt-prism-catalogue-publication-authority.md`.
- GitHub evidence is fixed to `https://api.github.com/repos/kyaulabs/prism`; npm evidence is fixed to `https://registry.npmjs.org`.
- Trigger values contain only a strict stable version and lowercase 40-hex commit and never supply compatibility, package identity, registry, sequence, branch, or payload authority.
- Every new `.js` file starts with an RCS header and ends with `// vim: ft=javascript sts=4 sw=4 ts=4 et :`.
- Every new `.md` file ends with `<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->`.
- Responses use `redirect: 'manual'`, omit credentials/referrers, have a 10-second per-attempt timeout, and stop reading after their declared byte bound.
- npm availability receives at most three attempts with fixed one-second delays: the operation is bounded to at most 32 seconds. Invalid or mismatched evidence is never retried.
- Production tests use fake GitHub/npm boundaries and synthetic Ed25519 keys only. No live network, production credential, private-key path, passphrase, or Git mutation enters tests.
- Existing `check-key`, `sign`, and `verify` behavior remains compatible. Manual local-source `prepare` is replaced by `prepare-release` and `prepare-renewal`.
- Baseline: `npm test` passes 39 tests on `develop`.

---

### Task 1: Deterministic Catalogue Source Policy

**Files:**
- Retain: `CONTEXT.md`
- Retain: `adr/README.md`
- Retain: `adr/0000-template.md`
- Retain: `adr/0001-adopt-prism-catalogue-publication-authority.md`
- Create: `src/catalogue-source.js`
- Modify: `src/payload.js`
- Create: `test/catalogue-source.test.js`
- Modify: `test/payload.test.js`

**Interfaces:**
- Consumes: signature-verified catalogue payloads and normalized release evidence shaped as `{adapters: Array<{id, displayName, packageName, releases}>}`.
- Produces: `readCatalogueSource(value)`, `sourceFromVerifiedCatalogue(catalogue)`, `applyReleaseEvidence({current, evidence})`, and `renderCatalogueSource(source)`.
- Invariant: adapters sort by `id`; releases sort by exact numeric SemVer ascending; an existing ID/package identity disagreement fails instead of replacing another adapter.

- [x] **Step 1: Write the failing source-policy tests**

Create `test/catalogue-source.test.js` with complete fixtures for these public behaviors:

```js
// $KYAULabs: catalogue-source.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyReleaseEvidence,
    renderCatalogueSource,
    sourceFromVerifiedCatalogue,
} from '../src/catalogue-source.js';

const integrity = `sha512-${Buffer.alloc(64, 17).toString('base64')}`;
const current = {
    schemaVersion: 1,
    catalogueId: 'kyaulabs/prism-adapters',
    sequence: 7,
    issuedAt: '2026-08-22T00:00:00.000Z',
    expiresAt: '2026-08-28T00:00:00.000Z',
    adapters: [{
        id: 'php-web',
        displayName: 'PHP/web',
        packageName: '@kyaulabs/prism-php-web',
        releases: [{
            version: '0.4.1',
            coreRange: '>=0.4.1 <0.5.0',
            bootstrapProtocol: 1,
            integrity,
            publishedAt: '2026-08-21T12:00:00.000Z',
            status: 'ACTIVE',
        }],
    }],
};

test('renewal source preserves verified releases while removing npm evidence', () => {
    assert.deepEqual(sourceFromVerifiedCatalogue(current).adapters[0].releases, [{
        version: '0.4.1',
        coreRange: '>=0.4.1 <0.5.0',
        bootstrapProtocol: 1,
        status: 'ACTIVE',
    }]);
});

test('release evidence replaces only its exact version', () => {
    const source = applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.1',
                coreRange: '>=0.4.1 <0.6.0',
                bootstrapProtocol: 1,
                status: 'REVOKED',
            }, {
                version: '0.4.2',
                coreRange: '>=0.4.1 <0.6.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }]},
    });

    assert.deepEqual(source.adapters[0].releases.map(({version, status}) => ({version, status})), [
        {version: '0.4.1', status: 'REVOKED'},
        {version: '0.4.2', status: 'ACTIVE'},
    ]);
    assert.equal(renderCatalogueSource(source), `${JSON.stringify(source, null, 2)}\n`);
});

test('release evidence cannot change an existing adapter package identity', () => {
    assert.throws(() => applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/other',
            releases: [],
        }]},
    }), /release evidence conflicts with the verified catalogue/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

Move the existing `readCatalogueSource` assertions from `test/payload.test.js` to this file without weakening them. Add cases proving numeric SemVer ordering beyond `Number` precision, unrelated adapter preservation, duplicate package rejection, and deterministic output from differently ordered normalized evidence.

- [x] **Step 2: Run the focused test to verify Red**

Run: `node --test test/catalogue-source.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/catalogue-source.js`.

- [x] **Step 3: Implement the source-policy module and delegate payload validation**

Move source validation from `src/payload.js` into `src/catalogue-source.js`. Keep exact-key, collection, ID, package, range, protocol, and status bounds unchanged. Implement release sorting with dot-separated `BigInt` components, not `Number` or locale ordering. `sourceFromVerifiedCatalogue` strips only `integrity` and `publishedAt`; `applyReleaseEvidence` clones that source, rejects ID/package collisions, replaces records by exact version, and returns `readCatalogueSource(...)`; `renderCatalogueSource` validates before returning UTF-8 pretty JSON with one trailing newline.

Update `src/payload.js` to import `readCatalogueSource` and remove its duplicate source validator. No payload schema or envelope behavior changes in this task.

- [x] **Step 4: Run focused and regression tests**

Run: `node --test test/catalogue-source.test.js test/payload.test.js test/envelope.test.js`

Expected: PASS with source preservation, replacement, conflict, deterministic rendering, payload, and envelope tests green.

- [x] **Step 5: Create the commit**

```bash
git add CONTEXT.md adr/README.md adr/0000-template.md adr/0001-adopt-prism-catalogue-publication-authority.md src/catalogue-source.js src/payload.js test/catalogue-source.test.js test/payload.test.js
prism-tool commit create --type fix --scope catalogue --subject "derive deterministic source from verified releases" --refs 3
```

### Task 2: Bounded npm Evidence Boundary

**Files:**
- Create: `src/evidence-http.js`
- Create: `src/npm-evidence.js`
- Modify: `src/payload.js`
- Create: `test/evidence-http.test.js`
- Create: `test/npm-evidence.test.js`
- Modify: `test/payload.test.js`

**Interfaces:**
- Produces: `EvidenceUnavailableError`, `EvidenceInvalidError`, and `requestBoundedJson({url, fetchImpl, maximumBytes, timeoutMs, headers, unavailableStatuses})`.
- Produces: `resolveNpmReleaseEvidence({packageName, version, fetchImpl, sleepImpl}) -> Promise<{integrity, publishedAt}>`.
- `hydrateCatalogue({source, sequence, now, npmEvidence})` consumes an injected `npmEvidence({packageName, version})`; the CLI later supplies the real npm boundary.

- [x] **Step 1: Write failing bounded-transport and npm tests**

Create table-driven tests that assert:

```js
const calls = [];
const evidence = await resolveNpmReleaseEvidence({
    packageName: '@kyaulabs/prism-php-web',
    version: '0.4.2',
    fetchImpl: async (url, options) => {
        calls.push({url, options});
        if (calls.length < 3) return new Response('{}', {status: 404});
        const body = JSON.stringify({
            versions: {'0.4.2': {dist: {integrity}}},
            time: {'0.4.2': '2026-08-28T12:00:00.000Z'},
        });
        return new Response(body, {
            status: 200,
            headers: {'content-length': String(Buffer.byteLength(body))},
        });
    },
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
});
assert.deepEqual(evidence, {
    integrity,
    publishedAt: '2026-08-28T12:00:00.000Z',
});
assert.equal(calls.length, 3);
assert.deepEqual(delays, [1000, 1000]);
assert.equal(calls[0].url,
    'https://registry.npmjs.org/%40kyaulabs%2Fprism-php-web');
assert.equal(calls[0].options.redirect, 'manual');
assert.equal(calls[0].options.credentials, 'omit');
```

Also cover: invalid package/version rejected before fetch; redirect; malformed or oversized `content-length`; streamed body crossing 4 MiB without `content-length`; empty/invalid JSON; missing exact version; malformed/noncanonical SHA-512; invalid publication time; retry exhaustion after exactly three attempts; and no retry for invalid evidence.

- [x] **Step 2: Run tests to verify Red**

Run: `node --test test/evidence-http.test.js test/npm-evidence.test.js`

Expected: FAIL with missing `src/evidence-http.js` and `src/npm-evidence.js` modules.

- [x] **Step 3: Implement bounded JSON and exact npm evidence**

`requestBoundedJson` must request with `redirect: 'manual'`, `credentials: 'omit'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`, fixed headers, and `AbortSignal.timeout(10_000)`. Reject `response.redirected`, all 3xx responses, invalid/oversized declared lengths, empty bodies, and bodies over the supplied maximum. Read `response.body` incrementally with `getReader()` and cancel immediately when the bound is exceeded; use `arrayBuffer()` only for fake responses without a readable stream and recheck the final length. Parse JSON once and return inert data.

`resolveNpmReleaseEvidence` validates strict stable SemVer and the `@kyaulabs/` package allowlist, requests the exact packument, and reads only `versions[version].dist.integrity` and `time[version]`. Retry only `EvidenceUnavailableError` up to three attempts with two injected 1,000 ms sleeps. Canonicalize publication time with `Date#toISOString`; require SHA-512 to decode to exactly 64 bytes and round-trip through base64.

Change `hydrateCatalogue` to require `npmEvidence` and call it for every exact release. Remove direct network behavior from `src/payload.js`; its responsibility becomes deterministic payload assembly and payload validation.

- [x] **Step 4: Run focused tests**

Run: `node --test test/evidence-http.test.js test/npm-evidence.test.js test/payload.test.js`

Expected: PASS; retry tests report exactly three attempts, invalid evidence reports one attempt, and payload hydration uses only the injected npm function.

- [x] **Step 5: Create the commit**

```bash
git add src/evidence-http.js src/npm-evidence.js src/payload.js test/evidence-http.test.js test/npm-evidence.test.js test/payload.test.js
prism-tool commit create --type fix --scope evidence --subject "bound exact npm release evidence" --refs 3
```

### Task 3: Immutable Prism GitHub Evidence Client

**Files:**
- Create: `src/github-evidence.js`
- Create: `test/github-evidence.test.js`

**Interfaces:**
- Produces: `resolvePrismReleaseEvidence({version, mergeCommit, fetchImpl}) -> Promise<{repository, version, mergeCommit, adapters}>`.
- The repository and origin are constants: `kyaulabs/prism` and `https://api.github.com`.
- `adapters` uses catalogue-source shape and contains no registry URL, integrity, publication time, command, credential, sequence, branch, or payload bytes.

- [x] **Step 1: Write the failing fake-GitHub contract tests**

Build a fake fetch keyed by exact request URL for:

```text
GET /repos/kyaulabs/prism/releases/tags/v0.4.2
GET /repos/kyaulabs/prism/git/ref/tags/v0.4.2
GET /repos/kyaulabs/prism/commits/<mergeCommit>
GET /repos/kyaulabs/prism/contents/.prism/release.json?ref=<mergeCommit>
GET /repos/kyaulabs/prism/contents/packages/prism-php-web/package.json?ref=<mergeCommit>
GET /repos/kyaulabs/prism/git/ref/tags/prism-php-web@0.4.2
```

The success fixture must use:

```js
const releaseConfiguration = {
    schemaVersion: 2,
    managedBy: '@kyaulabs/prism-core',
    versionPolicy: 'lockstep',
    packages: ['packages/prism-core', 'packages/prism-php-web'],
    adapterReleases: [{
        package: 'packages/prism-php-web',
        id: 'php-web',
        displayName: 'PHP/web',
        coreRange: '>=0.4.1 <0.5.0',
        bootstrapProtocol: 1,
        status: 'ACTIVE',
    }],
};
const packageManifest = {
    name: '@kyaulabs/prism-php-web',
    version: '0.4.2',
    prism: {
        adapter: true,
        bootstrapProtocol: 1,
        toolchain: './toolchain.json',
        handler: './scripts/prism-tool-adapter.js',
    },
    publishConfig: {access: 'public'},
};
```

Assert the normalized result contains only repository/version/commit and catalogue-source adapter records. Add one table case per fail-closed state: malformed trigger version/SHA, draft/prerelease Release, wrong Release tag or target commit, mutable/annotated/wrong release tag ref, commit mismatch or non-merge commit, release configuration unknown field/schema/owner/policy, escaping or undeclared package path, declaration unknown field/duplicate ID/invalid range/status/protocol, private or wrong-name/version/non-adapter manifest, package tag type/SHA mismatch, redirect, oversized content response, unavailable evidence, and unexpected request.

- [x] **Step 2: Run the focused test to verify Red**

Run: `node --test test/github-evidence.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/github-evidence.js`.

- [x] **Step 3: Implement independent GitHub evidence agreement**

Use `requestBoundedJson` for every request with GitHub API headers and a 4 MiB response limit; use 64 KiB for decoded `.prism/release.json` and 1 MiB for decoded package manifests. Validate lowercase 40-hex commit input and strict stable SemVer before any request.

Require the stable Release to be non-draft/non-prerelease with `tag_name === `v${version}`` and `target_commitish === mergeCommit`. Require both release and package refs to be direct commit refs at `mergeCommit`; annotated tags and wrong SHAs fail closed. Require the commit response SHA to match and have two parents.

Decode GitHub content responses only when `type === 'file'`, `encoding === 'base64'`, path matches exactly, declared size is within bounds, and decoded bytes round-trip canonically. Parse a closed release configuration with exact root and declaration keys. Require each declaration path to be a canonical relative member of `packages`, then validate its manifest name, exact version, public status, Prism adapter marker, and matching bootstrap protocol. Derive package tag prefixes from the package name after `/`; never accept tag names from evidence data.

Normalize each declaration to one catalogue-source release. Pass the complete normalized source shape through `readCatalogueSource` before returning it.

- [x] **Step 4: Run focused tests**

Run: `node --test test/github-evidence.test.js test/evidence-http.test.js test/catalogue-source.test.js`

Expected: PASS with every mismatch rejected before normalized release evidence is returned.

- [x] **Step 5: Create the commit**

```bash
git add src/github-evidence.js test/github-evidence.test.js
prism-tool commit create --type fix --scope evidence --subject "verify immutable Prism release evidence" --refs 3
```

### Task 4: Evidence-Backed Publisher CLI

**Files:**
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces CLI forms: `prepare-release <stable-version> <lowercase-40-hex-commit>` and `prepare-renewal`.
- `run(args, dependencies)` gains `githubFetchImpl`, `npmFetchImpl`, and `sleepImpl`; defaults remain built-in fetch and timer promises.
- Both preparation commands require and verify the existing `catalogue.json` with `allowExpired: true`, derive `sequence + 1`, render `catalogue-source.json`, and write `.publisher/payload.json` only after all evidence succeeds.

- [x] **Step 1: Replace the old prepare test with failing release and renewal integration tests**

Extend the existing temporary repository and synthetic-key helpers as `evidenceRepository()`. It returns `{cwd, key, mergeCommit, githubFetchImpl, npmFetchImpl, network}` and exposes `dependencies({githubFault, npmFault})` for Task 5. The release test must call:

```js
await run(['prepare-release', '0.4.2', mergeCommit], {
    cwd,
    expectedFingerprint: key.fingerprint,
    now: new Date('2026-08-28T00:00:00.000Z'),
    stdout: stdout.stream,
    githubFetchImpl: fakeGithub,
    npmFetchImpl: fakeNpm,
    sleepImpl: async () => {},
});
```

Seed `catalogue.json` with a valid expired sequence-7 synthetic envelope. Assert:

- `catalogue-source.json` preserves 0.4.1 and adds 0.4.2;
- `.publisher/payload.json` has sequence 8 and exact npm evidence for both releases;
- output identifies `release 0.4.2`, sequence 8, digest, and expiry;
- dispatch-supplied compatibility/package fields are impossible because the CLI accepts exactly version and commit.

The renewal test calls `run(['prepare-renewal'], ...)`, supplies no GitHub fake, and proves every existing exact npm release is revalidated while source records/statuses are unchanged.

Add failure assertions proving malformed CLI args fail before network access and any GitHub/npm error leaves both `catalogue-source.json` and `.publisher/payload.json` absent in the temporary repository.

- [x] **Step 2: Run the focused CLI tests to verify Red**

Run: `node --test --test-name-pattern="prepare-release|prepare-renewal|evidence failure" test/cli.test.js`

Expected: FAIL because the commands are unknown and the old `prepare` path still reads local source.

- [x] **Step 3: Compose verified evidence in the CLI**

Replace the old `prepare` branch with these flows:

```text
prepare-release
  load trusted public key
  verify existing catalogue with expiry allowed
  resolve immutable Prism release evidence
  apply exact release evidence to verified catalogue
  revalidate every exact npm release
  derive sequence + 1 and six-day payload
  render source bytes
  write source and private prepared payload atomically

prepare-renewal
  load trusted public key
  verify existing catalogue with expiry allowed
  derive source from the verified release set
  revalidate every exact npm release
  derive sequence + 1 and six-day payload
  render source bytes
  write source and private prepared payload atomically
```

Do not open the publisher work directory or create temporary output before evidence resolution and hydration complete. Prepare both byte buffers first. Continue using descriptor-anchored private work state for `.publisher/payload.json`; write generated `catalogue-source.json` through the existing bounded atomic writer. Keep `sign` tied only to the prepared payload and preserve `check-key`/`verify` behavior.

Update package scripts to:

```json
"catalogue:prepare-release": "node src/cli.js prepare-release",
"catalogue:prepare-renewal": "node src/cli.js prepare-renewal"
```

Remove `catalogue:prepare`. Do not change `package-lock.json`; npm lockfiles do not record script-only manifest changes, and no dependency changes are permitted.

- [x] **Step 4: Run CLI and full tests**

Run: `node --test test/cli.test.js`

Expected: PASS for release preparation, renewal, failure non-mutation, signing, verification, safe-file, and unknown-command behavior.

Run: `npm test`

Expected: PASS for the complete suite.

- [x] **Step 5: Create the commit**

```bash
git add src/cli.js test/cli.test.js package.json
prism-tool commit create --type fix --scope publisher --subject "prepare catalogues from verified evidence" --refs 3
```

### Task 5: Public Contract and Complete Fail-Closed Matrix

**Files:**
- Modify: `README.md`
- Modify: `test/cli.test.js`
- Modify: `test/github-evidence.test.js`
- Modify: `test/npm-evidence.test.js`
- Create: `test/documentation.test.js`
- Modify: `catalogue-source.json` only if deterministic rendering changes its bytes

**Interfaces:**
- Documents: release update and renewal command contracts, fixed evidence origins, generated-source policy, retry bound, and failure guarantees.
- Verifies: every acceptance criterion through fake boundaries and the public CLI.

- [ ] **Step 1: Add the final failing acceptance-matrix and public-contract tests**

Create the documentation contract first; it is Red until README stops presenting local source as authority:

```js
// $KYAULabs: documentation.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('documents evidence-backed preparation commands', () => {
    assert.match(readme, /catalogue:prepare-release -- <stable-version> <immutable-commit>/);
    assert.match(readme, /catalogue:prepare-renewal/);
    assert.match(readme, /generated.*catalogue-source[.]json/is);
    assert.doesNotMatch(readme, /Edit only `catalogue-source[.]json`/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

Add table-driven integration cases that inject one fault at a time and assert all preparation outputs remain unchanged. Define the optional-file helper and the first public-CLI case exactly as follows, then repeat the same assertions through `evidenceRepository().dependencies({githubFault, npmFault})` for the listed fault names:

```js
async function readOptional(filePath) {
    try {
        return await readFile(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

test('prepare-release fails closed on a redirected Release response', async () => {
    const fixture = await evidenceRepository();
    await assert.rejects(
        run(
            ['prepare-release', '0.4.2', fixture.mergeCommit],
            fixture.dependencies({githubFault: 'release-redirect'}),
        ),
        /Prism release evidence is invalid/,
    );
    assert.equal(await readOptional(path.join(fixture.cwd, 'catalogue-source.json')), null);
    assert.equal(await readOptional(path.join(fixture.cwd, '.publisher', 'payload.json')), null);
    assert.equal(fixture.network.gitMutations, 0);
});
```

The complete fault-name table is: `streamed-oversized-release`, `github-timeout-exhaustion`, `mutable-release-ref`, `prerelease`, `release-commit-disagreement`, `package-tag-disagreement`, `manifest-version-disagreement`, `declaration-unknown-field`, `protocol-mismatch`, `missing-npm-integrity`, `noncanonical-npm-integrity`, `invalid-npm-publication-time`, `verified-catalogue-identity-conflict`, and `unexpected-trigger-argument`. Add a renewal case proving unrelated releases and statuses survive byte-for-byte in rendered source while npm evidence is refreshed.

- [ ] **Step 2: Run the acceptance matrix to verify Red**

Run: `node --test test/documentation.test.js test/github-evidence.test.js test/npm-evidence.test.js test/cli.test.js`

Expected: FAIL in `documents evidence-backed preparation commands` because README still documents `catalogue:prepare` and hand-edited source. Boundary cases that are already implemented may pass; keep them as acceptance evidence.

- [ ] **Step 3: Complete hardening and update publisher documentation**

Make only the minimal boundary corrections exposed by Step 2. Do not broaden accepted schemas or add recovery shortcuts.

Rewrite README preparation guidance so it states:

- `catalogue-source.json` is generated and must not be hand-authored as authority;
- release update uses `npm run catalogue:prepare-release -- <stable-version> <immutable-commit>`;
- renewal uses `npm run catalogue:prepare-renewal`;
- GitHub and npm evidence origins are fixed;
- three npm attempts use one-second fixed delays and a 32-second maximum bound;
- any evidence mismatch or exhaustion writes no prepared payload and performs no signing or Git mutation;
- human/local signing instructions remain until the separate protected-signing slice replaces them.

If the committed `catalogue-source.json` is not already equal to `renderCatalogueSource(sourceFromVerifiedCatalogue(verifiedCatalogue))`, replace it with those deterministic bytes and make no policy change.

- [ ] **Step 4: Run final verification**

Run: `npm test`

Expected: PASS with all unit and integration tests.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `rg -n "catalogue:prepare([^/-]|$)|Edit only .*catalogue-source[.]json|\\[DEBUG-" README.md package.json src test`

Expected: no obsolete manual-prepare instructions and no debug instrumentation.

Run: `/check`

Expected: the project pre-push gate passes.

- [ ] **Step 5: Create the terminal implementation commit**

```bash
git add README.md test/cli.test.js test/github-evidence.test.js test/npm-evidence.test.js test/documentation.test.js catalogue-source.json
prism-tool commit create --type fix --scope security --subject "fail closed across release evidence boundaries" --fixes 3
```

After this commit, load `verification-before-completion`, then hand the completed branch to `finishing-a-development-branch` for cleanup, synchronization, repeated `/check`, four-axis review, and preparation-only `/pr`. The human remains responsible for pushing.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
