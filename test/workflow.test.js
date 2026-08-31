// $KYAULabs: workflow.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
    new URL('../.github/workflows/catalogue-signing.yml', import.meta.url),
    'utf8',
);

test('all trusted triggers share one non-cancelling publication transaction', () => {
    assert.match(workflow, /^on:\n  repository_dispatch:\n    types: \[prism-release-published\]/m);
    assert.match(workflow, /  schedule:\n    - cron: '0 6 [*] [*] [*]'/);
    assert.match(workflow, /  workflow_dispatch:\n    inputs:\n      mode:/);
    assert.match(workflow, /options:\n          - renewal\n          - release/);
    assert.match(workflow, /      version:\n        type: string/);
    assert.match(workflow, /      merge_commit:\n        type: string/);
    assert.match(workflow, /group: catalogue-publication/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /pull_request_target|workflow_call/);
});

test('separates signing and publication credentials behind read-only workflow permissions', () => {
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PRIVATE_KEY/g) ?? []).length, 1);
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PASSPHRASE/g) ?? []).length, 1);
    assert.equal((workflow.match(/secrets[.]CATALOGUE_PUBLICATION_TOKEN/g) ?? []).length, 1);
    assert.equal((workflow.match(
        /secrets[.]CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY/g,
    ) ?? []).length, 1);
    assert.equal((workflow.match(
        /secrets[.]CATALOGUE_COMMIT_SIGNING_PASSPHRASE/g,
    ) ?? []).length, 1);
    assert.equal((workflow.match(/CATALOGUE_SIGNING_ENABLED/g) ?? []).length, 2);
    assert.doesNotMatch(workflow, /CATALOGUE_PUBLICATION_APP|APP_ID|APP_PRIVATE_KEY/);
    assert.equal((workflow.match(/npm run catalogue:prepare-trigger/g) ?? []).length, 2);
    assert.equal((workflow.match(/id: preparation/g) ?? []).length, 2);
    assert.equal((workflow.match(
        /if: steps[.]preparation[.]outputs[.]publication_ready == 'true'/g,
    ) ?? []).length, 2);
    assert.match(workflow, /needs: synthetic-validation/);
    assert.match(workflow, /environment: catalogue-signing/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(workflow, /pull-requests: write|contents: write/);
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

test('keeps signing and publication behind exact activation', () => {
    const protectedJobStart = workflow.indexOf('  protected-signing:');
    assert.notEqual(protectedJobStart, -1);
    const protectedJob = workflow.slice(protectedJobStart);
    const jobPreamble = protectedJob.slice(0, protectedJob.indexOf('    runs-on:'));

    assert.match(jobPreamble, /vars[.]CATALOGUE_SIGNING_ENABLED == 'true'/);
    assert.match(
        protectedJob,
        /env:\n      CATALOGUE_SIGNING_ENABLED: 'true'\n      CATALOGUE_SIGNING_ENVIRONMENT: catalogue-signing/,
    );
    assert.match(
        protectedJob,
        /npm run catalogue:sign-protected[\s\S]+npm run catalogue:publish-protected/,
    );
});

test('workflow disables tracing, uses signing private files, and always cleans', () => {
    assert.match(workflow, /if: runner[.]debug == '1'/);
    assert.match(workflow, /set \+x/);
    assert.match(workflow, /umask 077/);
    assert.match(workflow, /trap 'rm -rf -- "\$secret_directory"' EXIT HUP INT TERM/);
    assert.match(workflow,
        /commit_signing_directory="\$\{RUNNER_TEMP\}\/prism-publication-commit-signing"/);
    assert.match(workflow,
        /trap 'rm -rf -- "\$commit_signing_directory"' EXIT HUP INT TERM/);
    assert.match(workflow,
        /unset ENCRYPTED_COMMIT_SIGNING_PRIVATE_KEY COMMIT_SIGNING_PASSPHRASE/);
    assert.match(workflow, /commit_signing_directory\/private[.]asc/);
    assert.match(workflow, /commit_signing_directory\/passphrase/);
    assert.doesNotMatch(workflow, /app_directory|app[.]pem/);
    assert.doesNotMatch(workflow, /echo .*COMMIT_SIGNING|GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /if: always[(][)]/);
    assert.match(workflow, /npm run catalogue:sign-protected/);
    assert.match(workflow, /npm run catalogue:verify/);
    assert.match(workflow, /npm run catalogue:publish-protected/);
});

test('workflow permits only the bounded direct publication command', () => {
    assert.doesNotMatch(
        workflow,
        /upload-artifact|actions\/cache|cache:|GITHUB_STEP_SUMMARY/,
    );
    assert.doesNotMatch(workflow, /GITHUB_OUTPUT/);
    assert.doesNotMatch(
        workflow,
        /git push|gh pr|update-ref|force.push|auto.merge|merge pull|close pull/,
    );
    assert.doesNotMatch(workflow, /permissions:\n(?:.|\n)*?contents: write/);
    assert.equal((workflow.match(/npm run catalogue:publish-protected/g) ?? []).length, 1);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
