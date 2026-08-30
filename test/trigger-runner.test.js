// $KYAULabs: trigger-runner.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createEnvelope} from '../src/envelope.js';
import {runTriggerPreparation} from '../src/trigger-runner.js';

async function fixture() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-trigger-runner-'));
    const runnerTemp = await mkdtemp(path.join(tmpdir(), 'prism-trigger-events-'));
    const eventPath = path.join(runnerTemp, 'event.json');
    const outputPath = path.join(runnerTemp, 'output');
    await writeFile(outputPath, '');
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
        runnerTemp,
        eventPath,
        outputPath,
        env: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'kyaulabs/prism-adapters',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: 'b'.repeat(40),
            GITHUB_EVENT_NAME: 'repository_dispatch',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
            GITHUB_WORKSPACE: cwd,
            RUNNER_TEMP: runnerTemp,
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
    assert.equal(await readFile(value.outputPath, 'utf8'), 'publication_ready=true\n');
});

test('prepares scheduled renewal through the same runner', async () => {
    const value = await fixture();
    value.env.GITHUB_EVENT_NAME = 'schedule';
    await writeFile(value.eventPath, '{"schedule":"0 6 * * *"}');
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
        scheduleDueImpl: async () => true,
    });

    assert.deepEqual(received, ['prepare-renewal']);
    assert.equal(await readFile(value.outputPath, 'utf8'), 'publication_ready=true\n');
});

test('runs scheduled renewal when the verified catalogue reaches three days', async () => {
    const value = await fixture();
    value.env.GITHUB_EVENT_NAME = 'schedule';
    await writeFile(value.eventPath, '{"schedule":"0 6 * * *"}');
    const pair = generateKeyPairSync('ed25519');
    const fingerprint = createHash('sha256')
        .update(pair.publicKey.export({type: 'spki', format: 'der'}))
        .digest('hex');
    const envelope = createEnvelope({
        payload: {
            schemaVersion: 1,
            catalogueId: 'kyaulabs/prism-adapters',
            sequence: 7,
            issuedAt: '2026-08-26T00:00:00.000Z',
            expiresAt: '2026-09-01T00:00:00.000Z',
            adapters: [{
                id: 'php-web',
                displayName: 'PHP/web',
                packageName: '@kyaulabs/prism-php-web',
                releases: [{
                    version: '1.2.3',
                    coreRange: '>=1.2.3 <2.0.0',
                    bootstrapProtocol: 1,
                    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
                    publishedAt: '2026-08-25T12:00:00.000Z',
                    status: 'ACTIVE',
                }],
            }],
        },
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
    });
    await writeFile(path.join(value.cwd, 'catalogue.json'), envelope);
    await writeFile(path.join(value.cwd, 'adapter-catalogue-public.pem'),
        pair.publicKey.export({type: 'spki', format: 'pem'}));
    let called = false;

    await runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: fingerprint,
        prepareImpl: async () => {
            called = true;
            await mkdir(path.join(value.cwd, '.publisher'), {mode: 0o700});
            return {sequence: 8, payloadDigest: 'c'.repeat(64)};
        },
    });

    assert.equal(called, true);
    assert.equal(await readFile(value.outputPath, 'utf8'), 'publication_ready=true\n');
});

test('skips scheduled renewal until the verified catalogue is three days old', async () => {
    const value = await fixture();
    value.env.GITHUB_EVENT_NAME = 'schedule';
    await writeFile(value.eventPath, '{"schedule":"0 6 * * *"}');
    let called = false;

    const result = await runTriggerPreparation({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        prepareImpl: async () => {
            called = true;
        },
        scheduleDueImpl: async () => false,
    });

    assert.deepEqual(result, {ready: false, trigger: {kind: 'renewal'}});
    assert.equal(called, false);
    assert.equal(await readFile(value.outputPath, 'utf8'), 'publication_ready=false\n');
    await triggerAbsent(value.cwd);
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
