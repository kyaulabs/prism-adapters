// $KYAULabs: automation-workflows.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const ciWorkflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
);
const backMergeWorkflow = await readFile(
    new URL('../.github/workflows/back-merge.yml', import.meta.url),
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
        /gh pr list --repo "\$GITHUB_REPOSITORY"[\s\\]+--base develop --head main --state open/,
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

// vim: ft=javascript sts=4 sw=4 ts=4 et :
