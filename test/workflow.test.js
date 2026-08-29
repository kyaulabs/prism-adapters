// $KYAULabs: workflow.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
    new URL('../.github/workflows/catalogue-signing.yml', import.meta.url),
    'utf8',
);

test('protected signing is manual, activation-gated, and main-only', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
    assert.match(workflow, /github[.]ref == 'refs\/heads\/main'/);
    assert.match(workflow, /github[.]event_name == 'workflow_dispatch'/);
    assert.match(workflow, /vars[.]CATALOGUE_SIGNING_ENABLED == 'true'/);
    assert.match(workflow, /environment: catalogue-signing/);
    assert.match(workflow, /timeout-minutes: 10/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /pull_request_target|workflow_call/);
});

test('only the protected signing step receives production secrets', () => {
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PRIVATE_KEY/g) ?? []).length, 1);
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PASSPHRASE/g) ?? []).length, 1);
    assert.match(workflow, /needs: synthetic-validation/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.match(
        workflow,
        /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/,
    );
    assert.match(
        workflow,
        /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/,
    );
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /ref: \$\{\{ github[.]sha \}\}/);
});

test('workflow disables tracing, uses private files, and always cleans', () => {
    assert.match(workflow, /if: runner[.]debug == '1'/);
    assert.match(workflow, /set \+x/);
    assert.match(workflow, /umask 077/);
    assert.match(workflow, /trap 'rm -rf -- "\$secret_directory"' EXIT HUP INT TERM/);
    assert.match(workflow, /if: always[(][)]/);
    assert.match(workflow, /npm run catalogue:sign-protected/);
    assert.match(workflow, /npm run catalogue:verify/);
});

test('workflow has no secret-bearing transport or remote mutation', () => {
    assert.doesNotMatch(
        workflow,
        /upload-artifact|actions\/cache|cache:|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY/,
    );
    assert.doesNotMatch(workflow, /git push|gh pr|auto-merge|merge pull|force/);
    assert.doesNotMatch(workflow, /permissions:\n(?:.|\n)*?contents: write/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
