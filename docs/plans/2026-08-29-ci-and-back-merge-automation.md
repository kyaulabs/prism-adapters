# CI and Back-Merge Automation Implementation Plan

> **For the executing agent:** Implement this plan task-by-task by loading the
> `executing-plans` and `tdd` skills. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task follows Red → Green → Refactor inline.

**Goal:** Test every protected-branch change and automatically open one human-merged `main` to `develop` back-merge pull request after integration.

**Architecture:** Add one read-only CI workflow and one independently bounded back-merge workflow. Lock their YAML contracts with Node tests so triggers, action revisions, permissions, branch direction, duplicate handling, and prohibited effects cannot drift silently.

**Tech Stack:** GitHub Actions; GitHub CLI on hosted runners; Node.js 22.19.0 built-ins and `node:test`; no new dependencies.

**Originating issue:** none

## Global constraints

- CI runs on pushes to and pull requests targeting `develop` and `main`.
- CI receives only `contents: read`, no secrets, and no mutation authority.
- Back-merge automation receives only `contents: read` and `pull-requests: write` through `GITHUB_TOKEN`.
- Back-merge automation never checks out or executes repository code.
- Only merged pull requests into `main` may initiate a back-merge check.
- Automation may create one `main` to `develop` pull request but may not push, update refs, force-push, approve, merge, auto-merge, or close pull requests.
- Remote API values and errors are untrusted data and never become executable shell input.
- Exact duplicate state is idempotent success; malformed, ambiguous, or unexpected state fails closed.
- Human administrators must enable the repository setting that permits GitHub Actions to create pull requests.
- Human review and merge remain required.
- Use the existing immutable checkout and setup-node revisions.
- Add no dependency.

---

### Task 1: Add protected-branch continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `test/automation-workflows.test.js`

**Interfaces:**
- Consumes: GitHub push and pull-request revisions for `develop` and `main`; committed `package-lock.json`; package scripts from `package.json`.
- Produces: one stable `Node.js tests` check that runs `npm ci` and `npm test` under Node.js 22.19.0.

- [x] **Step 1: Write the failing CI workflow contract test**

Create `test/automation-workflows.test.js`:

```js
// $KYAULabs: automation-workflows.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const ciWorkflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
);

test('CI tests pushes and pull requests for both protected branches', () => {
    assert.match(ciWorkflow, /^on:\n  push:\n    branches: \[develop, main\]/m);
    assert.match(ciWorkflow, /  pull_request:\n    branches: \[develop, main\]/);
    assert.match(ciWorkflow, /group: ci-\$\{\{ github[.]workflow \}\}-\$\{\{ github[.]ref \}\}/);
    assert.match(ciWorkflow, /cancel-in-progress: false/);
});

test('CI runs the locked Node suite with read-only authority', () => {
    assert.match(ciWorkflow, /^permissions:\n  contents: read/m);
    assert.match(ciWorkflow, /name: Node[.]js tests/);
    assert.match(ciWorkflow, /runs-on: ubuntu-latest/);
    assert.match(ciWorkflow, /timeout-minutes: 10/);
    assert.match(
        ciWorkflow,
        /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/,
    );
    assert.match(ciWorkflow, /persist-credentials: false/);
    assert.match(ciWorkflow, /ref: \$\{\{ github[.]sha \}\}/);
    assert.match(
        ciWorkflow,
        /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/,
    );
    assert.match(ciWorkflow, /node-version: 22[.]19[.]0/);
    assert.match(ciWorkflow, /run: npm ci/);
    assert.match(ciWorkflow, /run: npm test/);
});

test('CI has no secret, publication, artifact, cache, or mutation surface', () => {
    assert.doesNotMatch(ciWorkflow, /secrets[.]|contents: write|pull-requests: write/);
    assert.doesNotMatch(ciWorkflow, /upload-artifact|actions\/cache|cache:/);
    assert.doesNotMatch(ciWorkflow, /catalogue:|git push|gh |curl |wget /);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [x] **Step 2: Run the focused test to verify Red**

Run: `node --test test/automation-workflows.test.js`

Expected: FAIL because `.github/workflows/ci.yml` does not exist.

- [x] **Step 3: Implement the minimal CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: Continuous integration

on:
  push:
    branches: [develop, main]
  pull_request:
    branches: [develop, main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

jobs:
  test:
    name: Node.js tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Check out exact event revision
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
          ref: ${{ github.sha }}
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22.19.0
      - name: Install locked dependencies
        run: npm ci
      - name: Run tests
        run: npm test
```

- [x] **Step 4: Run focused and full tests to verify Green**

Run: `node --test test/automation-workflows.test.js`

Expected: PASS with 3 tests.

Run: `npm test`

Expected: PASS for the complete Node suite.

- [x] **Step 5: Create the CI commit**

Stage separately:

```bash
git add .github/workflows/ci.yml test/automation-workflows.test.js
```

Then load `conventional-commits` and run as the only tool call in its assistant batch:

```bash
prism-tool commit create --type ci --scope actions --subject "test protected branch changes"
```

---

### Task 2: Add bounded automatic back-merge pull requests

**Files:**
- Create: `.github/workflows/back-merge.yml`
- Modify: `test/automation-workflows.test.js`
- Modify: `test/documentation.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: a merged GitHub pull-request event targeting `main`; GitHub compare and pull-request APIs through the built-in `GITHUB_TOKEN`.
- Produces: either no mutation when state is current/exact, or one open pull request with head `main` and base `develop` for human review.

- [x] **Step 1: Extend workflow and documentation tests for the back-merge contract**

Add after the `ciWorkflow` declaration in `test/automation-workflows.test.js`:

```js
const backMergeWorkflow = await readFile(
    new URL('../.github/workflows/back-merge.yml', import.meta.url),
    'utf8',
);
```

Add before the vim modeline in that file:

```js
test('back-merge runs only after a pull request is merged into main', () => {
    assert.match(backMergeWorkflow, /^on:\n  pull_request:\n    branches: \[main\]\n    types: \[closed\]/m);
    assert.match(backMergeWorkflow, /github[.]event[.]pull_request[.]merged == true/);
    assert.match(backMergeWorkflow, /group: back-merge-main-to-develop/);
    assert.match(backMergeWorkflow, /cancel-in-progress: false/);
});

test('back-merge has only read and pull-request creation authority', () => {
    assert.match(
        backMergeWorkflow,
        /^permissions:\n  contents: read\n  pull-requests: write/m,
    );
    assert.match(backMergeWorkflow, /GH_TOKEN: \$\{\{ secrets[.]GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(backMergeWorkflow, /actions\/checkout|contents: write/);
});

test('back-merge compares exact refs and creates only the intended pull request', () => {
    assert.match(backMergeWorkflow, /compare\/develop[.][.][.]main/);
    assert.match(
        backMergeWorkflow,
        /gh pr list --repo "\$GITHUB_REPOSITORY" --base develop --head main --state open/,
    );
    assert.match(
        backMergeWorkflow,
        /gh pr create --repo "\$GITHUB_REPOSITORY" --base develop --head main/,
    );
    assert.match(backMergeWorkflow, /--title "Back-merge main into develop"/);
    assert.match(backMergeWorkflow, /Human review and merge required[.]/);
    assert.match(backMergeWorkflow, /case "\$ahead_by" in/);
    assert.match(backMergeWorkflow, /case "\$open_count" in/);
});

test('back-merge fails closed and has no integration authority', () => {
    assert.doesNotMatch(
        backMergeWorkflow,
        /git push|update-ref|force.push|gh pr merge|gh pr close|gh pr review|auto.merge/,
    );
    assert.doesNotMatch(backMergeWorkflow, /eval|source |bash -c|sh -c/);
    assert.match(backMergeWorkflow, /pull-request creation failed/);
    assert.match(backMergeWorkflow, /created concurrently; nothing to do/);
});
```

Add before the vim modeline in `test/documentation.test.js`:

```js
test('documents CI and automatic human-merged back-merges', () => {
    assert.match(readme, /pushes and pull requests targeting `develop` and `main`/);
    assert.match(readme, /GitHub Actions.*create pull requests/is);
    assert.match(readme, /`main` to `develop` back-merge pull request/);
    assert.match(readme, /Human review and merge remain required/);
});
```

- [x] **Step 2: Run the focused tests to verify Red**

Run: `node --test test/automation-workflows.test.js test/documentation.test.js`

Expected: FAIL because `.github/workflows/back-merge.yml` and the README contract do not exist.

- [x] **Step 3: Implement the bounded back-merge workflow**

Create `.github/workflows/back-merge.yml`:

```yaml
name: Back-merge main

on:
  pull_request:
    branches: [main]
    types: [closed]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: back-merge-main-to-develop
  cancel-in-progress: false

jobs:
  open-back-merge:
    name: Open back-merge pull request
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: write
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - name: Reconcile main into develop
        shell: bash
        run: |
          set -euo pipefail

          if ! ahead_by=$(gh api "repos/$GITHUB_REPOSITORY/compare/develop...main" --jq '.ahead_by'); then
            echo "::error::back-merge comparison failed" >&2
            exit 1
          fi
          case "$ahead_by" in
            ''|*[!0-9]*)
              echo "::error::back-merge comparison was malformed" >&2
              exit 1
              ;;
          esac
          if [ "$ahead_by" -eq 0 ]; then
            echo "develop already contains main; nothing to do"
            exit 0
          fi

          if ! open_count=$(gh pr list --repo "$GITHUB_REPOSITORY" \
            --base develop --head main --state open --json number --jq 'length'); then
            echo "::error::back-merge pull-request inspection failed" >&2
            exit 1
          fi
          case "$open_count" in
            ''|*[!0-9]*)
              echo "::error::back-merge pull-request state was malformed" >&2
              exit 1
              ;;
          esac
          if [ "$open_count" -eq 1 ]; then
            echo "open back-merge pull request already exists; nothing to do"
            exit 0
          fi
          if [ "$open_count" -ne 0 ]; then
            echo "::error::back-merge pull-request state is ambiguous" >&2
            exit 1
          fi

          if gh pr create --repo "$GITHUB_REPOSITORY" --base develop --head main \
            --title "Back-merge main into develop" \
            --body "Automated back-merge pull request. Human review and merge required." \
            >/dev/null 2>&1; then
            echo "opened back-merge pull request"
            exit 0
          fi

          if ! open_count=$(gh pr list --repo "$GITHUB_REPOSITORY" \
            --base develop --head main --state open --json number --jq 'length'); then
            echo "::error::back-merge pull-request creation failed" >&2
            exit 1
          fi
          if [ "$open_count" = '1' ]; then
            echo "back-merge pull request was created concurrently; nothing to do"
            exit 0
          fi

          echo "::error::back-merge pull-request creation failed" >&2
          exit 1
```

The second inspection compares only the literal count string to `1`; no remote value is evaluated or used as shell source. Unexpected state fails with a generic error and does not enter logs.

- [x] **Step 4: Document CI and the repository prerequisite**

Add this section to `README.md` before its vim modeline:

```markdown
## Repository automation

The continuous integration workflow runs the locked Node test suite for pushes and pull requests targeting `develop` and `main`.

After a pull request is merged into `main`, the back-merge workflow opens one `main` to `develop` back-merge pull request when synchronization is needed. Human review and merge remain required; automation never pushes or merges either protected branch.

A repository administrator must enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. This setting permits pull-request creation; the workflow itself does not approve pull requests and receives only read-only contents plus pull-request write authority.
```

- [x] **Step 5: Run focused and full tests to verify Green**

Run: `node --test test/automation-workflows.test.js test/documentation.test.js`

Expected: PASS with all automation and documentation contract tests.

Run: `npm test`

Expected: PASS for the complete Node suite.

Run: `git diff --check`

Expected: PASS with no output.

- [x] **Step 6: Create the back-merge commit**

Stage separately:

```bash
git add .github/workflows/back-merge.yml test/automation-workflows.test.js test/documentation.test.js README.md docs/plans/2026-08-29-ci-and-back-merge-automation.md
```

Then load `conventional-commits` and run as the only tool call in its assistant batch:

```bash
prism-tool commit create --type ci --scope actions --subject "open automatic back-merge pull requests"
```

---

## Final verification and handoff

After both tasks are committed:

1. Run `npm test`.
2. Run `/check` and require GO.
3. Run the authorized four-axis `code-review` during finalization.
4. Remove this completed plan and its matching spec under the development-artifact lifecycle.
5. Prepare the pull request without pushing or mutating GitHub.
6. Before relying on automatic back-merges, have a human administrator enable GitHub Actions pull-request creation in repository settings.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
