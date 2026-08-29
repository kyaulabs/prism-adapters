// $KYAULabs: trigger-runner.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runTriggerPreparation} from '../src/trigger-runner.js';

async function fixture() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-trigger-runner-'));
    const eventPath = path.join(cwd, 'event.json');
    await writeFile(eventPath, JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
        },
    }));
    return {
        cwd,
        eventPath,
        env: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'kyaulabs/prism-adapters',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: 'b'.repeat(40),
            GITHUB_EVENT_NAME: 'repository_dispatch',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_WORKSPACE: cwd,
            GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/main',
        },
    };
}

async function triggerAbsent(cwd) {
    await assert.rejects(
        readFile(path.join(cwd, '.publisher', 'trigger.json')),
        /ENOENT/,
    );
}

test('prepares a release from a closed trigger and persists its intent', async () => {
    const value = await fixture();
    let received;

    const result = await runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        prepareImpl: async (args) => {
            received = args;
            await mkdir(path.join(value.cwd, '.publisher'), {mode: 0o700});
            return {sequence: 8, payloadDigest: 'c'.repeat(64)};
        },
    });

    assert.deepEqual(received, ['prepare-release', '1.2.3', 'a'.repeat(40)]);
    assert.deepEqual(result, {
        baseSha: 'b'.repeat(40),
        preparedSequence: 8,
        payloadDigest: 'c'.repeat(64),
        trigger: {
            kind: 'release',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
        },
    });
    assert.deepEqual(
        JSON.parse(await readFile(path.join(value.cwd, '.publisher', 'trigger.json'), 'utf8')),
        {schemaVersion: 1, ...result},
    );
});

test('prepares scheduled renewal through the same runner', async () => {
    const value = await fixture();
    value.env.GITHUB_EVENT_NAME = 'schedule';
    await writeFile(value.eventPath, '{"schedule":"0 6 */3 * *"}');
    let received;

    await runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        prepareImpl: async (args) => {
            received = args;
            await mkdir(path.join(value.cwd, '.publisher'), {mode: 0o700});
            return {sequence: 8, payloadDigest: 'c'.repeat(64)};
        },
    });

    assert.deepEqual(received, ['prepare-renewal']);
});

for (const [name, change] of [
    ['wrong repository', {GITHUB_REPOSITORY: 'someone/example'}],
    ['non-main ref', {GITHUB_REF: 'refs/heads/feature'}],
    ['reusable workflow', {GITHUB_EVENT_NAME: 'workflow_call'}],
    ['wrong workflow', {
        GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/other.yml@refs/heads/main',
    }],
    ['relative event path', {GITHUB_EVENT_PATH: 'event.json'}],
    ['changed workspace', {GITHUB_WORKSPACE: '/tmp'}],
]) {
    test(`rejects ${name} before preparation`, async () => {
        const value = await fixture();
        let called = false;

        await assert.rejects(runTriggerPreparation({
            cwd: value.cwd,
            env: {...value.env, ...change},
            stdout: {write: () => {}},
            prepareImpl: async () => {
                called = true;
            },
        }), /catalogue trigger runner is not trusted/);
        assert.equal(called, false);
        await triggerAbsent(value.cwd);
    });
}

test('failed preparation leaves no trigger record', async () => {
    const value = await fixture();

    await assert.rejects(runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        prepareImpl: async () => {
            await mkdir(path.join(value.cwd, '.publisher'), {mode: 0o700});
            throw new Error('synthetic preparation failure');
        },
    }), /catalogue trigger preparation failed/);
    await triggerAbsent(value.cwd);
});

test('malformed event leaves no trigger record', async () => {
    const value = await fixture();
    await writeFile(value.eventPath, '{');

    await assert.rejects(runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        prepareImpl: async () => {
            throw new Error('must not prepare');
        },
    }), /catalogue trigger preparation failed/);
    await triggerAbsent(value.cwd);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
