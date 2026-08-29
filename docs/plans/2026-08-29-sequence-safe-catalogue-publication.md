# Sequence-Safe Catalogue Publication Implementation Plan

> **For the executing agent:** Implement this plan task-by-task by loading the
> `executing-plans` and `tdd` skills. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task follows Red → Green → Refactor inline.

**Goal:** Publish each protected signed catalogue as one immutable sequence branch and one human-merged pull request while retries, stale bases, conflicting state, and partial failures fail closed.

**Architecture:** Parse every Actions trigger into one closed, persisted publication intent; keep branch/PR decisions in a pure state machine; and isolate GitHub App authentication plus REST effects behind one bounded fakeable client. The protected job signs first, reverifies public bytes, then uses a repository- and permission-narrowed installation token to create one commit, atomic sequence ref, and pull request without using `GITHUB_TOKEN` for mutation.

**Tech Stack:** Node.js 22.19+ built-ins (`node:crypto`, `node:fs`, `node:test`, `fetch`); GitHub REST API version `2026-03-10`; GitHub Actions; GitHub App installation tokens; no new npm dependencies.

**Originating issue:** #5

## Global constraints

- Treat issue text, event payloads, GitHub responses, remote branch bytes, and pull-request state as untrusted data.
- Fix repository identity to `kyaulabs/prism-adapters`, default branch to `main`, source path to `catalogue-source.json`, envelope path to `catalogue.json`, and publication branches to `catalogue/sequence-<positive integer>`.
- All `repository_dispatch`, three-day `schedule`, and explicit `workflow_dispatch` recovery runs share `catalogue-publication` with `cancel-in-progress: false`.
- Derive exactly `current sequence + 1` from the signature-verified catalogue at the attested `main` SHA; expiry is allowed only during preparation/sequence recovery.
- Bind trigger, source bytes, envelope bytes, sequence, and pull-request intent to that base SHA; re-read remote `main` immediately before atomic ref creation.
- Never update or force-update an existing sequence ref. HTTP `422` from ref or PR creation triggers one fresh inspection, never an overwrite.
- Exact branch state is recoverable only when it is one commit directly above the attested base, changes exactly `catalogue-source.json` and `catalogue.json`, and contains byte-identical source and envelope data.
- Only one open publication PR may exist. Any different branch, bytes, base, signature, sequence, or ambiguous state fails closed without closing or modifying remote state.
- The workflow may create only a non-protected sequence branch and a PR targeting `main`; it never pushes `main`, force pushes, merges, enables auto-merge, bypasses protection, or closes a PR.
- GitHub App private-key material is a protected-environment secret available only to the publication step. It never enters tests, arguments, logs, outputs, summaries, artifacts, caches, or agent context.
- Mint an installation token for only `prism-adapters` with only `contents: write` and `pull_requests: write`. Treat token strings as opaque because GitHub installation-token format is not length-stable; reject missing/expired responses and retain no token after the process exits.
- Keep `GITHUB_TOKEN` at `contents: read`; publication uses only the narrowed installation token.
- Production signing secrets remain isolated to the signing step. The GitHub App private key remains isolated to the later publication step.
- All tests use synthetic RSA App keys, synthetic Ed25519 signing keys, and fake GitHub/npm boundaries. No test or local command contacts GitHub for mutation.
- `CATALOGUE_SIGNING_ENABLED` remains the existing repository-level activation gate. GitHub App/environment provisioning remains a human administration task.
- Every new JavaScript file starts with the RCS header and ends with the JavaScript vim modeline.

---

### Task 1: Normalize trusted publication triggers

**Files:**
- Create: `src/publication-trigger.js`
- Create: `src/trigger-runner.js`
- Create: `test/publication-trigger.test.js`
- Create: `test/trigger-runner.test.js`
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: bounded event bytes, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_SHA`, and the existing `run()` preparation interface from `src/cli.js`.
- Produces: `parsePublicationTrigger({eventName, eventBytes}) -> Frozen<{kind, version?, mergeCommit?}>`; preparation commands return `Frozen<{sequence, payloadDigest}>`; `runTriggerPreparation({cwd, env, stdout, prepareImpl}) -> Promise<Frozen<{baseSha, preparedSequence, payloadDigest, trigger}>>`; package command `catalogue:prepare-trigger`.

- [x] **Step 1: Write failing trigger parser tests**

Create `test/publication-trigger.test.js` with table tests for these exact accepted values:

```js
assert.deepEqual(parsePublicationTrigger({
    eventName: 'schedule',
    eventBytes: Buffer.from('{"schedule":"0 6 */3 * *"}'),
}), {kind: 'renewal'});

assert.deepEqual(parsePublicationTrigger({
    eventName: 'repository_dispatch',
    eventBytes: Buffer.from(JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
        },
    })),
}), {
    kind: 'release',
    version: '1.2.3',
    mergeCommit: 'a'.repeat(40),
});

assert.deepEqual(parsePublicationTrigger({
    eventName: 'workflow_dispatch',
    eventBytes: Buffer.from(JSON.stringify({
        inputs: {mode: 'renewal', version: '', merge_commit: ''},
    })),
}), {kind: 'renewal'});
```

Cover manual release mode and reject malformed JSON, non-object input, unknown events/actions, unknown `client_payload` or `inputs` fields, wrong repository, prerelease/malformed versions, non-lowercase/non-40-byte commits, and renewal mode carrying release identifiers.

- [x] **Step 2: Run the parser tests to verify Red**

Run: `node --test test/publication-trigger.test.js`

Expected: FAIL because `src/publication-trigger.js` does not exist.

- [x] **Step 3: Implement the closed trigger parser**

Create `src/publication-trigger.js` with exact-key validation and these constants/exports:

```js
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function parsePublicationTrigger({eventName, eventBytes}) {
    if (!Buffer.isBuffer(eventBytes) || eventBytes.length === 0 ||
        eventBytes.length > 65_536) {
        throw new Error('catalogue publication trigger is invalid');
    }
    let event;
    try {
        event = JSON.parse(eventBytes.toString('utf8'));
    } catch {
        throw new Error('catalogue publication trigger is invalid');
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('catalogue publication trigger is invalid');
    }
    if (eventName === 'schedule') return Object.freeze({kind: 'renewal'});
    if (eventName === 'repository_dispatch') {
        const payload = event.client_payload;
        if (event.action !== 'prism-release-published' || !exactKeys(payload, [
            'schemaVersion', 'repository', 'version', 'mergeCommit',
        ]) || payload.schemaVersion !== 1 || payload.repository !== 'kyaulabs/prism' ||
            !RELEASE.test(payload.version ?? '') || !COMMIT.test(payload.mergeCommit ?? '')) {
            throw new Error('catalogue publication trigger is invalid');
        }
        return Object.freeze({
            kind: 'release',
            version: payload.version,
            mergeCommit: payload.mergeCommit,
        });
    }
    if (eventName === 'workflow_dispatch' && exactKeys(event.inputs, [
        'mode', 'version', 'merge_commit',
    ])) {
        if (event.inputs.mode === 'renewal' && event.inputs.version === '' &&
            event.inputs.merge_commit === '') {
            return Object.freeze({kind: 'renewal'});
        }
        if (event.inputs.mode === 'release' && RELEASE.test(event.inputs.version ?? '') &&
            COMMIT.test(event.inputs.merge_commit ?? '')) {
            return Object.freeze({
                kind: 'release',
                version: event.inputs.version,
                mergeCommit: event.inputs.merge_commit,
            });
        }
    }
    throw new Error('catalogue publication trigger is invalid');
}
```

Define `exactKeys()` locally so only the nested authority-bearing objects are closed; ignore unrelated top-level GitHub event metadata.

- [x] **Step 4: Write failing runner tests**

Create `test/trigger-runner.test.js` using a temporary event file and injected `prepareImpl`. Assert that trusted Actions provenance invokes:

```js
['prepare-release', '1.2.3', 'a'.repeat(40)]
```

or:

```js
['prepare-renewal']
```

Have the preparation fake return `{sequence: 8, payloadDigest: 'c'.repeat(64)}` and assert `.publisher/trigger.json` contains exactly:

```json
{"schemaVersion":1,"baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","preparedSequence":8,"payloadDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","trigger":{"kind":"release","version":"1.2.3","mergeCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
```

Cover wrong repository/ref/workflow, pull request/reusable event, relative event path, event path outside `GITHUB_WORKSPACE`, changed workspace, failed preparation, and malformed event. Every failure leaves no trigger file.

- [x] **Step 5: Implement the trigger runner and package command**

Create `src/trigger-runner.js`. Read `GITHUB_EVENT_PATH` with `readBoundedRegularFile`, require it to be an absolute path inside canonical `GITHUB_WORKSPACE === cwd`, require trusted `main` workflow provenance and a lowercase 40-character `GITHUB_SHA`, parse the trigger, invoke the existing CLI `run()` with fixed arguments, validate its positive `sequence` and lowercase SHA-256 `payloadDigest`, then atomically write `.publisher/trigger.json` with `preparedSequence` and `payloadDigest`. Default `env` from `process.env` with a rule-specific `nosemgrep: prism-no-process-env` comment citing ADR-0095’s accepted Actions provenance boundary.

Modify both preparation branches in `src/cli.js` to return this value after successful persistence and stdout reporting:

```js
return Object.freeze({sequence: payload.sequence, payloadDigest: digest});
```

Extend `test/cli.test.js` to assert the returned sequence and digest for release and renewal preparation. Verification and key-check commands continue to return `undefined`.

Add to `package.json`:

```json
"catalogue:prepare-trigger": "node src/trigger-runner.js"
```

- [x] **Step 6: Run focused and full tests**

Run: `node --test test/publication-trigger.test.js test/trigger-runner.test.js test/cli.test.js`

Expected: PASS; all rejected contexts leave no `.publisher/trigger.json`.

Run: `npm test`

Expected: PASS.

- [x] **Step 7: Create the commit**

Run `git add package.json src/publication-trigger.js src/trigger-runner.js test/publication-trigger.test.js test/trigger-runner.test.js docs/plans/2026-08-29-sequence-safe-catalogue-publication.md`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "validate catalogue publication triggers" --refs 5
```

---

### Task 2: Model sequence-safe publication state

**Files:**
- Create: `src/publication-state.js`
- Create: `test/publication-state.test.js`

**Interfaces:**
- Consumes: a closed local intent and normalized remote snapshot.
- Produces: `publicationBranch(sequence) -> string`; `decidePublication({intent, remote}) -> Frozen<{action, branchName, pullRequestNumber?}>` where action is `CREATE_BRANCH`, `CREATE_PULL_REQUEST`, or `IDEMPOTENT`.

- [ ] **Step 1: Write the failing state table**

Use one fixed intent:

```js
const intent = {
    baseSha: 'a'.repeat(40),
    sequence: 8,
    branchName: 'catalogue/sequence-8',
    sourceDigest: 'b'.repeat(64),
    envelopeDigest: 'c'.repeat(64),
};
```

Cover this complete matrix in `test/publication-state.test.js`:

| Remote state | Expected |
| --- | --- |
| matching main, no branch, no publication PR | `CREATE_BRANCH` |
| matching exact branch, no PR | `CREATE_PULL_REQUEST` |
| matching exact branch and exact PR | `IDEMPOTENT` with PR number |
| moved main | throw `catalogue publication base is stale` |
| branch has wrong name/base/source/envelope/files/commit count | throw `catalogue publication state conflicts` |
| PR has wrong head/base/base SHA/head SHA | throw conflict |
| another open publication PR | throw conflict |
| more than one open publication PR | throw conflict |
| PR exists without branch | throw conflict |
| malformed intent, snapshot, digest, SHA, sequence, or PR number | throw invalid |

- [ ] **Step 2: Run the state tests to verify Red**

Run: `node --test test/publication-state.test.js`

Expected: FAIL because `src/publication-state.js` does not exist.

- [ ] **Step 3: Implement the pure state machine**

Create `src/publication-state.js` around this closed decision core:

```js
export function publicationBranch(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('catalogue publication intent is invalid');
    }
    return `catalogue/sequence-${sequence}`;
}

export function decidePublication({intent, remote}) {
    validateIntent(intent);
    validateRemote(remote);
    if (remote.mainSha !== intent.baseSha) {
        throw new Error('catalogue publication base is stale');
    }
    const branch = remote.branch;
    const publicationPulls = remote.openPullRequests.filter(({headRef}) =>
        headRef.startsWith('catalogue/sequence-'));
    if (publicationPulls.length > 1 ||
        publicationPulls.some(({headRef}) => headRef !== intent.branchName)) {
        throw new Error('catalogue publication state conflicts');
    }
    if (branch === null) {
        if (publicationPulls.length !== 0) conflict();
        return Object.freeze({action: 'CREATE_BRANCH', branchName: intent.branchName});
    }
    if (branch.name !== intent.branchName || branch.baseSha !== intent.baseSha ||
        branch.sourceDigest !== intent.sourceDigest ||
        branch.envelopeDigest !== intent.envelopeDigest ||
        branch.changedFilesExact !== true || branch.commitCount !== 1) {
        conflict();
    }
    if (publicationPulls.length === 0) {
        return Object.freeze({action: 'CREATE_PULL_REQUEST', branchName: intent.branchName});
    }
    const pull = publicationPulls[0];
    if (pull.baseRef !== 'main' || pull.baseSha !== intent.baseSha ||
        pull.headRef !== intent.branchName || pull.headSha !== branch.commitSha) {
        conflict();
    }
    return Object.freeze({
        action: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: pull.number,
    });
}
```

Implement closed validators for exactly the fields used above. `remote.branch` is either `null` or the exact branch shape; `openPullRequests` is a bounded array of at most 100 normalized entries. `conflict()` throws only the generic conflict error so untrusted remote values never enter logs.

- [ ] **Step 4: Run the state tests to verify Green**

Run: `node --test test/publication-state.test.js`

Expected: PASS for every transition and conflict.

- [ ] **Step 5: Create the commit**

Run `git add src/publication-state.js test/publication-state.test.js`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "model sequence-safe publication state" --refs 5
```

---

### Task 3: Add the bounded GitHub App publication client

**Files:**
- Create: `src/github-publication.js`
- Create: `test/github-publication.test.js`

**Interfaces:**
- Consumes: synthetic or protected RSA App private-key bytes, numeric App ID, fixed repository state, source/envelope bytes, deterministic PR title/body, and injected `fetchImpl`/clock.
- Produces: `mintPublisherToken({appId, privateKeyBytes, fetchImpl, now}) -> Promise<{token, expiresAt}>`; `publishCatalogueCandidate({token, intent, sourceBytes, envelopeBytes, title, body, fetchImpl}) -> Promise<{state, branchName, pullRequestNumber}>`.

- [ ] **Step 1: Write failing App-token tests**

Generate a synthetic RSA key in `test/github-publication.test.js`. Decode the JWT payload received by the fake fetch and assert numeric `iss`, `iat = now - 60`, `exp = now + 540`, and a valid RSA-SHA256 signature. Assert requests occur in this order:

```text
GET  /repos/kyaulabs/prism-adapters/installation
POST /app/installations/<validated-positive-id>/access_tokens
```

Assert the token request body is exactly:

```json
{
  "repositories": ["prism-adapters"],
  "permissions": {
    "contents": "write",
    "pull_requests": "write"
  }
}
```

Accept an opaque non-empty token without a length assumption and require an RFC3339 expiry later than `now` and no more than one hour ahead. Reject malformed App IDs, non-RSA keys, redirects, oversized/empty/non-JSON responses, wrong repository installation, absent permissions, overbroad returned permissions, missing repository selection, expired tokens, and unexpected status codes.

- [ ] **Step 2: Run token tests to verify Red**

Run: `node --test --test-name-pattern='installation token' test/github-publication.test.js`

Expected: FAIL because `src/github-publication.js` does not exist.

- [ ] **Step 3: Implement token minting with built-ins**

Create `src/github-publication.js` with fixed API origin and version headers:

```js
const API = 'https://api.github.com/repos/kyaulabs/prism-adapters';
const API_VERSION = '2026-03-10';
const USER_AGENT = '@kyaulabs/prism-adapters-catalogue';
```

Build the JWT with base64url header `{"alg":"RS256","typ":"JWT"}`, the exact timestamps above, numeric App ID, and `node:crypto.sign('RSA-SHA256', ...)`. Use guarded `fetch` with `redirect: 'manual'`, `credentials: 'omit'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`, `AbortSignal.timeout(10_000)`, bounded 4 MiB JSON reads, exact expected statuses, and generic errors. Never log or return the JWT. Return only the opaque installation token and expiry to the caller.

- [ ] **Step 4: Write failing remote-inspection and mutation tests**

Using a queued fake fetch, cover:

1. Read `heads/main` and require an exact commit SHA.
2. List at most 100 open PRs targeting `main`.
3. Treat branch `404` as absent.
4. For an existing sequence branch, compare base to head and require exactly one commit, zero behind, exact merge base, and exactly the two modified paths.
5. Read both remote files at the branch commit, decode canonical base64, and derive SHA-256 digests.
6. For `CREATE_BRANCH`, create two blobs, a base-tree-derived tree, one commit with the attested base as its sole parent, re-read `main`, then create `refs/heads/catalogue/sequence-<n>` exactly once.
7. For `CREATE_PULL_REQUEST`, create a non-draft PR targeting `main` with `maintainer_can_modify: false`.
8. For `IDEMPOTENT`, perform no POST.
9. On ref/PR HTTP `422`, re-inspect once and accept only exact idempotent/recovery state.

Reject redirects, pagination beyond one bounded page, malformed content, extra changed files, multiple commits, wrong parent/base, wrong PR state, unrecognized response fields required for authority, and any non-race mutation failure. Assert no request uses `PATCH`, `PUT`, `DELETE`, merge, update-ref, force, or protected `main` mutation endpoints.

- [ ] **Step 5: Implement inspection and publication**

Implement `publishCatalogueCandidate()` as a maximum-three-transition loop:

```js
for (let transition = 0; transition < 3; transition += 1) {
    const remote = await inspectRemotePublication({token, intent, fetchImpl});
    const decision = decidePublication({intent, remote});
    if (decision.action === 'IDEMPOTENT') return frozenResult(decision);
    if (decision.action === 'CREATE_BRANCH') {
        await createSequenceBranch({token, intent, sourceBytes, envelopeBytes, fetchImpl});
        continue;
    }
    if (decision.action === 'CREATE_PULL_REQUEST') {
        await createPublicationPullRequest({token, intent, title, body, fetchImpl});
        continue;
    }
}
throw new Error('catalogue publication state is ambiguous');
```

`createSequenceBranch()` must re-read `main` after creating Git objects but before `POST /git/refs`; stale main throws and leaves only unreachable Git objects, never a visible branch. Treat only `422` from ref or PR creation as a race requiring reinspection. All other mutation responses fail immediately.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/github-publication.test.js test/publication-state.test.js`

Expected: PASS with fake HTTP only.

Run: `npm test`

Expected: PASS.

- [ ] **Step 7: Create the commit**

Run `git add src/github-publication.js test/github-publication.test.js`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "bound GitHub publication effects" --refs 5
```

---

### Task 4: Publish only reverified protected output

**Files:**
- Create: `src/publication-runner.js`
- Create: `test/publication-runner.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: fixed workspace files, trusted Actions provenance, protected App-key file, `APP_ID`, `verifyEnvelope`, and the Task 3 client.
- Produces: `runProtectedPublication({cwd, env, stdout, tokenImpl, publishImpl, now}) -> Promise<{state, branchName, pullRequestNumber}>`; package command `catalogue:publish-protected`.

- [ ] **Step 1: Write failing protected publication tests**

Build temporary fixtures with synthetic Ed25519 catalogue keys/envelopes and a synthetic RSA App key. Assert the runner:

- reads `catalogue-source.json`, `catalogue.json`, `.publisher/trigger.json`, `adapter-catalogue-public.pem`, and `$RUNNER_TEMP/prism-catalogue-publication/app.pem` from fixed paths only;
- reverifies the envelope with the committed public-key fingerprint and current time;
- requires envelope sequence to equal `triggerRecord.preparedSequence`, envelope payload digest to equal `triggerRecord.payloadDigest`, and source content to represent the same adapter release set;
- derives SHA-256 source/envelope digests and `catalogue/sequence-<n>`;
- passes only reverified public bytes and a closed intent to `publishImpl`;
- constructs a deterministic title `chore(catalogue): publish sequence <n>`;
- constructs a PR body containing sequence, issued/expiry times, base SHA, release evidence commit when present, trigger class, every adapter/release evidence field, and an explicit human-merge statement;
- fills App private-key bytes after token minting and removes the private app directory on success and every failure;
- emits only sequence, branch, PR number, and state.

Reject local/non-main/wrong-workflow/debug/disabled contexts, missing or malformed trigger metadata, wrong base SHA, malformed App ID, non-private App key file, invalid signature, wrong sequence, source/envelope disagreement, stale base, and publication conflicts before reporting success.

- [ ] **Step 2: Run runner tests to verify Red**

Run: `node --test test/publication-runner.test.js`

Expected: FAIL because `src/publication-runner.js` does not exist.

- [ ] **Step 3: Implement protected publication orchestration**

Create `src/publication-runner.js` with the same fixed repository/ref/workflow/event/debug/activation provenance as `src/protected-runner.js`. Default `env` from `process.env` with a rule-specific `nosemgrep: prism-no-process-env` comment citing ADR-0095. Read bounded files without following symlinks; read the App key with `readBoundedPrivateFile`; fill its buffer in `finally`; and remove only an absolute `$RUNNER_TEMP/prism-catalogue-publication` directory proven outside the workspace.

Verify the source using `readCatalogueSource(JSON.parse(sourceBytes))`, verify the envelope using `verifyEnvelope`, and compare normalized release sets before minting a token. Construct this exact intent shape:

```js
Object.freeze({
    baseSha: triggerRecord.baseSha,
    sequence: triggerRecord.preparedSequence,
    branchName: publicationBranch(triggerRecord.preparedSequence),
    sourceDigest: sha256(sourceBytes),
    envelopeDigest: verified.envelopeDigest,
})
```

Call `mintPublisherToken()` only after all local validation succeeds, call `publishCatalogueCandidate()`, and never write the token or key-derived data to stdout/stderr.

Add to `package.json`:

```json
"catalogue:publish-protected": "node src/publication-runner.js"
```

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/publication-runner.test.js test/protected-runner.test.js test/protected-signing.test.js`

Expected: PASS; synthetic secrets are removed on every path.

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Create the commit**

Run `git add package.json src/publication-runner.js test/publication-runner.test.js`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope publication --subject "publish protected catalogue candidates" --refs 5
```

---

### Task 5: Converge all Actions triggers on the protected transaction

**Files:**
- Modify: `.github/workflows/catalogue-signing.yml`
- Modify: `test/workflow.test.js`

**Interfaces:**
- Consumes: `repository_dispatch` action `prism-release-published`; cron renewal; manual `renewal|release` recovery inputs; environment secrets `CATALOGUE_SIGNING_PRIVATE_KEY`, `CATALOGUE_SIGNING_PASSPHRASE`, and `CATALOGUE_PUBLICATION_APP_PRIVATE_KEY`; variables `CATALOGUE_SIGNING_ENABLED` and `CATALOGUE_PUBLICATION_APP_ID`.
- Produces: one serialized prepare → sign → verify → publish transaction.

- [ ] **Step 1: Replace readiness-only drift tests with failing transaction guards**

Update `test/workflow.test.js` to require:

```yaml
on:
  repository_dispatch:
    types: [prism-release-published]
  schedule:
    - cron: '0 6 */3 * *'
  workflow_dispatch:
```

Require manual choice input `mode` with only `renewal` and `release`, plus string `version` and `merge_commit`. Require one `catalogue-publication` concurrency group and `cancel-in-progress: false`.

Require both unprivileged and protected jobs to run `npm run catalogue:prepare-trigger`; require protected signing before protected publication; require `npm run catalogue:verify` between them. Require only one reference each to all three protected secret names. Require `CATALOGUE_PUBLICATION_APP_ID` only in the publication step.

Keep top-level and job `GITHUB_TOKEN` permissions at `contents: read`. Require no `pull-requests: write` workflow permission because the narrowed App token owns mutation. Require the existing immutable checkout/setup-node pins and `persist-credentials: false`.

Forbid `git push`, `gh pr`, update-ref, force, merge, auto-merge, PR close, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, artifacts, and caches. Permit publication only through `npm run catalogue:publish-protected`.

- [ ] **Step 2: Run workflow tests to verify Red**

Run: `node --test test/workflow.test.js`

Expected: FAIL because the workflow is manual/readiness-only and has no publication step.

- [ ] **Step 3: Implement the three-trigger protected workflow**

Modify `.github/workflows/catalogue-signing.yml` so both jobs retain ten-minute bounds and exact trusted-SHA checkout. The unprivileged job runs tests and `npm run catalogue:prepare-trigger`. The protected job remains activation-, repository-, `main`-, event-, and environment-gated; it reruns tests and preparation from current authority.

Keep signing and App credentials in separate steps:

```yaml
      - name: Sign and reverify in protected environment
        env:
          ENCRYPTED_PRIVATE_KEY: ${{ secrets.CATALOGUE_SIGNING_PRIVATE_KEY }}
          PRIVATE_KEY_PASSPHRASE: ${{ secrets.CATALOGUE_SIGNING_PASSPHRASE }}
        run: |
          set +x
          umask 077
          secret_directory="${RUNNER_TEMP}/prism-catalogue-signing"
          trap 'rm -rf -- "$secret_directory"' EXIT HUP INT TERM
          rm -rf -- "$secret_directory"
          mkdir --mode=700 -- "$secret_directory"
          printf '%s' "$ENCRYPTED_PRIVATE_KEY" > "$secret_directory/private.pem"
          printf '%s' "$PRIVATE_KEY_PASSPHRASE" > "$secret_directory/passphrase"
          unset ENCRYPTED_PRIVATE_KEY PRIVATE_KEY_PASSPHRASE
          npm run catalogue:sign-protected
          npm run catalogue:verify

      - name: Publish immutable sequence branch and pull request
        env:
          APP_ID: ${{ vars.CATALOGUE_PUBLICATION_APP_ID }}
          APP_PRIVATE_KEY: ${{ secrets.CATALOGUE_PUBLICATION_APP_PRIVATE_KEY }}
        run: |
          set +x
          umask 077
          app_directory="${RUNNER_TEMP}/prism-catalogue-publication"
          trap 'rm -rf -- "$app_directory"' EXIT HUP INT TERM
          rm -rf -- "$app_directory"
          mkdir --mode=700 -- "$app_directory"
          printf '%s' "$APP_PRIVATE_KEY" > "$app_directory/app.pem"
          unset APP_PRIVATE_KEY
          npm run catalogue:publish-protected
```

Add independent `if: always()` cleanup for both private directories. Do not upload source/envelope artifacts; the publication client sends only the intended public bytes to the sequence commit.

- [ ] **Step 4: Run workflow and full tests**

Run: `node --test test/workflow.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS, including fake-GitHub race and partial-failure coverage.

Re-run the corrected original debug loop, which recognizes App-backed mutation while requiring workflow `GITHUB_TOKEN` to remain read-only:

```bash
node --input-type=module -e "import{readFileSync}from'node:fs';const s=readFileSync('.github/workflows/catalogue-signing.yml','utf8');const canPublish=/repository_dispatch:/.test(s)&&/schedule:/.test(s)&&/npm run catalogue:publish-protected/.test(s)&&/CATALOGUE_PUBLICATION_APP_PRIVATE_KEY/.test(s)&&!/contents:\s*write/.test(s);if(!canPublish){console.error('RED: protected workflow cannot create a sequence branch and human-merged publication PR');process.exit(1)}console.log('GREEN: sequence-safe publication path exists')"
```

Expected: `GREEN: sequence-safe publication path exists`.

- [ ] **Step 5: Create the commit**

Run `git add .github/workflows/catalogue-signing.yml test/workflow.test.js`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope actions --subject "automate sequence-safe catalogue publication" --refs 5
```

---

### Task 6: Document App custody, activation, and recovery

**Files:**
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `test/documentation.test.js`

**Interfaces:**
- Consumes: the workflow, variable, secret, branch, and PR contract from Tasks 1–5.
- Produces: operator-facing provisioning, least-privilege, review, recovery, succession, and activation instructions.

- [ ] **Step 1: Write failing documentation contract tests**

Extend `test/documentation.test.js` to require:

- `CONTEXT.md` states that sequence branches are immutable, only exact partial state is recoverable, and humans merge publication PRs.
- `README.md` names all three triggers, `CATALOGUE_PUBLICATION_APP_ID`, `CATALOGUE_PUBLICATION_APP_PRIVATE_KEY`, `catalogue:prepare-trigger`, and `catalogue:publish-protected`.
- `README.md` states that the App installation is restricted to `kyaulabs/prism-adapters`, the runtime token requests only contents/PR writes, and `GITHUB_TOKEN` remains read-only.
- `SECURITY.md` covers App private-key custody, one-hour installation-token expiry, opaque token format, environment-only injection, log retention, administrator succession, exposure response, and separate rotation from the Ed25519 catalogue key.
- All documents prohibit protected-branch writes, force push, merge, auto-merge, corrective close, and local production publication.
- `package.json` has the two new runner-only scripts and no local publish command.

- [ ] **Step 2: Run documentation tests to verify Red**

Run: `node --test test/documentation.test.js`

Expected: FAIL because issue #5 is still described as future work.

- [ ] **Step 3: Update domain and operator documentation**

Update `CONTEXT.md` without implementation paths:

- Add sequence-branch immutability, exact branch/PR recovery, stale-base abort, one-open-PR, and human-merge invariants to `Catalogue Publication Transaction`.
- Add GitHub App installation authority and administrators who can replace App material to the GitHub/human trust boundaries.
- Keep direct protected-branch writes, force push, merge, and auto-merge in non-goals.

Update `README.md` with exact human provisioning steps:

1. Install the dedicated App only on `kyaulabs/prism-adapters` with repository contents and pull-request write permissions, no merge/admin/release/npm authority.
2. Configure `CATALOGUE_PUBLICATION_APP_ID` as a repository Actions variable.
3. Configure `CATALOGUE_PUBLICATION_APP_PRIVATE_KEY` as an environment-scoped secret on `catalogue-signing`.
4. Retain an offline recovery copy, set seven-day Actions log retention, review default-branch/environment policy, and leave `CATALOGUE_SIGNING_ENABLED` false until the complete transaction is ready.
5. Explain dispatch, three-day renewal, and manual release/renewal recovery inputs.
6. Explain sequence branch/PR review and that only humans merge.

Update `SECURITY.md` so suspected App-key exposure disables `CATALOGUE_SIGNING_ENABLED`, revokes/replaces the App key, reviews installation/repository grants and audit logs, and re-enables only after synthetic and protected readiness checks. Keep catalogue signing-key exposure on the separate Core-first trust-root rotation path.

- [ ] **Step 4: Run final verification**

Run: `node --test test/documentation.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `git status --short`

Expected: only Task 6 files before the terminal commit; no `.publisher` state, secret file, generated `.new` file, artifact, debug tag, or App token appears.

Run: `rg -n '\[DEBUG-|APP_PRIVATE_KEY=|ghs_[A-Za-z0-9_]+|git push|force.push|auto.merge' src test README.md SECURITY.md CONTEXT.md .github/workflows package.json`

Expected: no secret/token/debug match; any policy/test match for forbidden operations is clearly a negative assertion, not executable behavior.

The finishing workflow must run `/check`, four-axis `code-review`, and preparation-only `/pr`. It must never push or mutate GitHub.

- [ ] **Step 5: Create the terminal implementation commit**

Run `git add CONTEXT.md README.md SECURITY.md test/documentation.test.js`, then load `conventional-commits` and run as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope security --subject "document catalogue publication custody" --fixes 5
```

---

## Self-review record

- **Acceptance coverage:** Task 5 supplies one non-cancelling concurrency group for all triggers; Tasks 2–4 abort stale bases, model exact retry/recovery, reject conflicts, create only immutable sequence refs and human-merged PRs, and prohibit direct/force/merge/close effects; Tasks 2–4 cover races and partial failures through pure-state and fake-GitHub tests.
- **Authority coverage:** Task 3 narrows the App token to one repository and contents/PR writes, treats the token as opaque under GitHub’s staged 2026 stateless format, and requires expiry no later than one hour. Task 5 keeps `GITHUB_TOKEN` read-only and isolates signing/App secrets by step.
- **ADR coverage:** local ADR-0001 already adopts immutable upstream ADR-0095. Architect verdict is GO-WITH-CONDITIONS with `ADR-required: none`; no local decision supersedes accepted authority.
- **Scope boundary:** no task provisions the App/environment, reads production secrets, writes/merges `main`, automates npm publication, changes Core dispatch code, or pushes from the coding agent.
- **Dependencies:** no npm dependency is added. GitHub REST calls use Node built-ins and API version `2026-03-10`; current official documentation confirms repository and permission narrowing and one-hour installation-token expiry.
- **Issue references:** Tasks 1–5 use `--refs 5`; Task 6 alone uses `--fixes 5`.
- **Adapter commands:** no stack adapter applies; commands use repository-native Node.js 22.19 scripts and the built-in test runner.
- **Plan lifecycle:** include this plan in the first implementation commit and remove it during finalization after all tasks are complete.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
