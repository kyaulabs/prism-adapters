// $KYAULabs: protected-runner.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runProtectedSigning} from '../src/protected-runner.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'prism-protected-runner-'));
    const cwd = path.join(root, 'workspace');
    const runnerTemp = path.join(root, 'runner-temp');
    const secretDirectory = path.join(runnerTemp, 'prism-catalogue-signing');
    await mkdir(path.join(cwd, '.publisher'), {recursive: true, mode: 0o700});
    await mkdir(secretDirectory, {recursive: true, mode: 0o700});
    await writeFile(path.join(secretDirectory, 'private.pem'), 'synthetic key', {mode: 0o600});
    await writeFile(path.join(secretDirectory, 'passphrase'), 'synthetic passphrase', {
        mode: 0o600,
    });
    return {
        cwd,
        runnerTemp,
        secretDirectory,
        env: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'kyaulabs/prism-adapters',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: 'a'.repeat(40),
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/main',
            RUNNER_TEMP: runnerTemp,
            CATALOGUE_SIGNING_ENVIRONMENT: 'catalogue-signing',
            CATALOGUE_SIGNING_ENABLED: 'true',
        },
    };
}

async function secretsAbsent(directory) {
    await assert.rejects(readFile(path.join(directory, 'private.pem')), /ENOENT/);
    await assert.rejects(readFile(path.join(directory, 'passphrase')), /ENOENT/);
}

test('passes fixed paths to protected signing and cleans secrets on success', async () => {
    const value = await fixture();
    let received;
    await runProtectedSigning({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        signImpl: async (options) => {
            received = options;
            return {sequence: 9, envelopeDigest: 'a'.repeat(64)};
        },
    });

    assert.equal(received.payloadPath, path.join(value.cwd, '.publisher', 'payload.json'));
    assert.equal(received.publicKeyPath, path.join(value.cwd, 'adapter-catalogue-public.pem'));
    assert.equal(received.privateKeyPath, path.join(value.secretDirectory, 'private.pem'));
    assert.equal(received.passphrasePath, path.join(value.secretDirectory, 'passphrase'));
    assert.equal(received.outputPath, path.join(value.cwd, 'catalogue.json'));
    await secretsAbsent(value.secretDirectory);
});

test('cleans secret files when signing fails', async () => {
    const value = await fixture();

    await assert.rejects(runProtectedSigning({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        signImpl: async () => {
            throw new Error('synthetic signing failure');
        },
    }), /protected catalogue signing failed/);
    await secretsAbsent(value.secretDirectory);
});

for (const [name, change] of [
    ['pull request', {GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge'}],
    ['reusable workflow', {GITHUB_EVENT_NAME: 'workflow_call'}],
    ['non-main ref', {GITHUB_REF: 'refs/heads/feature'}],
    ['non-default workflow code', {
        GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/feature',
    }],
    ['debug runner', {RUNNER_DEBUG: '1'}],
    ['missing activation', {CATALOGUE_SIGNING_ENABLED: undefined}],
    ['false activation', {CATALOGUE_SIGNING_ENABLED: 'false'}],
    ['uppercase activation', {CATALOGUE_SIGNING_ENABLED: 'TRUE'}],
    ['whitespace-padded activation', {CATALOGUE_SIGNING_ENABLED: ' true '}],
    ['malformed activation', {CATALOGUE_SIGNING_ENABLED: 'enabled'}],
]) {
    test(`rejects ${name} before protected signing`, async () => {
        const value = await fixture();
        let called = false;

        await assert.rejects(runProtectedSigning({
            cwd: value.cwd,
            env: {...value.env, ...change},
            stdout: {write: () => {}},
            signImpl: async () => {
                called = true;
            },
        }), /protected signing runner is not trusted/);
        assert.equal(called, false);
        await secretsAbsent(value.secretDirectory);
    });
}

test('does not clean a fallback path for a relative runner temp', async () => {
    const value = await fixture();
    const fallbackDirectory = path.join(value.cwd, 'prism-catalogue-signing');
    await mkdir(fallbackDirectory, {mode: 0o700});
    await writeFile(path.join(fallbackDirectory, 'sentinel'), 'keep');

    await assert.rejects(runProtectedSigning({
        cwd: value.cwd,
        env: {...value.env, RUNNER_TEMP: 'relative'},
        stdout: {write: () => {}},
    }), /protected signing runner is not trusted/);
    assert.equal(await readFile(path.join(fallbackDirectory, 'sentinel'), 'utf8'), 'keep');
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
