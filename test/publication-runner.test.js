// $KYAULabs: publication-runner.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {renderCatalogueSource, sourceFromVerifiedCatalogue} from '../src/catalogue-source.js';
import {createEnvelopeFromPayloadBytes} from '../src/envelope.js';
import {runProtectedPublication} from '../src/publication-runner.js';

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function fixture() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-publication-runner-'));
    const runnerTemp = await mkdtemp(path.join(tmpdir(), 'prism-publication-secrets-'));
    const appDirectory = path.join(runnerTemp, 'prism-catalogue-publication');
    await mkdir(path.join(cwd, '.publisher'), {mode: 0o700});
    await mkdir(appDirectory, {mode: 0o700});
    const signing = generateKeyPairSync('ed25519');
    const app = generateKeyPairSync('rsa', {modulusLength: 2048});
    const publicDer = signing.publicKey.export({type: 'spki', format: 'der'});
    const fingerprint = sha256(publicDer);
    const payload = {
        schemaVersion: 1,
        catalogueId: 'kyaulabs/prism-adapters',
        sequence: 8,
        issuedAt: '2026-08-29T00:00:00.000Z',
        expiresAt: '2026-09-04T00:00:00.000Z',
        adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '1.2.3',
                coreRange: '>=1.2.3 <2.0.0',
                bootstrapProtocol: 1,
                integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
                publishedAt: '2026-08-28T12:00:00.000Z',
                status: 'ACTIVE',
            }],
        }],
    };
    const payloadBytes = Buffer.from(`${JSON.stringify(payload)}\n`);
    const envelopeBytes = createEnvelopeFromPayloadBytes({
        payloadBytes,
        privateKey: signing.privateKey,
        publicKey: signing.publicKey,
    });
    const sourceBytes = Buffer.from(renderCatalogueSource(sourceFromVerifiedCatalogue(payload)));
    const baseSha = 'a'.repeat(40);
    await writeFile(path.join(cwd, 'adapter-catalogue-public.pem'), signing.publicKey.export({
        type: 'spki',
        format: 'pem',
    }));
    await writeFile(path.join(cwd, 'catalogue-source.json'), sourceBytes);
    await writeFile(path.join(cwd, 'catalogue.json'), envelopeBytes);
    await writeFile(path.join(cwd, '.publisher', 'trigger.json'), `${JSON.stringify({
        schemaVersion: 1,
        baseSha,
        preparedSequence: 8,
        payloadDigest: sha256(payloadBytes),
        trigger: {
            kind: 'release',
            version: '1.2.3',
            mergeCommit: 'b'.repeat(40),
        },
    })}\n`);
    await writeFile(path.join(appDirectory, 'app.pem'), app.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
    }), {mode: 0o600});
    return {
        cwd,
        runnerTemp,
        appDirectory,
        fingerprint,
        sourceBytes,
        envelopeBytes,
        baseSha,
        env: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'kyaulabs/prism-adapters',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: baseSha,
            GITHUB_EVENT_NAME: 'repository_dispatch',
            GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/main',
            RUNNER_TEMP: runnerTemp,
            CATALOGUE_SIGNING_ENVIRONMENT: 'catalogue-signing',
            CATALOGUE_SIGNING_ENABLED: 'true',
            APP_ID: '12345',
        },
    };
}

async function appSecretAbsent(directory) {
    await assert.rejects(readFile(path.join(directory, 'app.pem')), /ENOENT/);
}

test('reverifies and publishes only the fixed protected catalogue candidate', async () => {
    const value = await fixture();
    let tokenInput;
    let publication;
    let output = '';

    const result = await runProtectedPublication({
        cwd: value.cwd,
        env: value.env,
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: value.fingerprint,
        stdout: {write: (chunk) => { output += chunk; }},
        tokenImpl: async (input) => {
            tokenInput = input;
            return {token: 'opaque-synthetic-token', expiresAt: '2026-08-29T01:00:00.000Z'};
        },
        publishImpl: async (input) => {
            publication = input;
            return {
                state: 'IDEMPOTENT',
                branchName: 'catalogue/sequence-8',
                pullRequestNumber: 17,
            };
        },
    });

    assert.equal(tokenInput.appId, '12345');
    assert.ok(Buffer.isBuffer(tokenInput.privateKeyBytes));
    assert.deepEqual(publication.intent, {
        baseSha: value.baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(value.sourceBytes),
        envelopeDigest: sha256(value.envelopeBytes),
    });
    assert.deepEqual(publication.sourceBytes, value.sourceBytes);
    assert.deepEqual(publication.envelopeBytes, value.envelopeBytes);
    assert.equal(publication.token, 'opaque-synthetic-token');
    assert.equal(publication.title, 'chore(catalogue): publish sequence 8');
    assert.match(publication.body, /Sequence: 8/);
    assert.match(publication.body, /Base commit: `a{40}`/);
    assert.match(publication.body, /Evidence commit: `b{40}`/);
    assert.match(publication.body, /@kyaulabs\/prism-php-web@1[.]2[.]3/);
    assert.match(publication.body, /Human review and merge are required/);
    assert.deepEqual(result, {
        state: 'IDEMPOTENT',
        branchName: 'catalogue/sequence-8',
        pullRequestNumber: 17,
    });
    assert.equal(output, 'published catalogue sequence 8 branch catalogue/sequence-8 PR #17 state IDEMPOTENT\n');
    await appSecretAbsent(value.appDirectory);
});

for (const [name, change] of [
    ['local execution', {GITHUB_ACTIONS: 'false'}],
    ['non-main ref', {GITHUB_REF: 'refs/heads/feature'}],
    ['wrong workflow', {
        GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/other.yml@refs/heads/main',
    }],
    ['debug logging', {RUNNER_DEBUG: '1'}],
    ['disabled activation', {CATALOGUE_SIGNING_ENABLED: 'false'}],
]) {
    test(`rejects ${name} before token minting`, async () => {
        const value = await fixture();
        let called = false;

        await assert.rejects(runProtectedPublication({
            cwd: value.cwd,
            env: {...value.env, ...change},
            now: new Date('2026-08-29T00:00:00.000Z'),
            expectedFingerprint: value.fingerprint,
            stdout: {write: () => {}},
            tokenImpl: async () => {
                called = true;
            },
        }), /protected publication runner is not trusted/);
        assert.equal(called, false);
        await appSecretAbsent(value.appDirectory);
    });
}

test('rejects mismatched trigger and signed output before token minting', async () => {
    const value = await fixture();
    const triggerPath = path.join(value.cwd, '.publisher', 'trigger.json');
    const trigger = JSON.parse(await readFile(triggerPath, 'utf8'));
    trigger.preparedSequence = 9;
    await writeFile(triggerPath, `${JSON.stringify(trigger)}\n`);
    let called = false;

    await assert.rejects(runProtectedPublication({
        cwd: value.cwd,
        env: value.env,
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: value.fingerprint,
        stdout: {write: () => {}},
        tokenImpl: async () => {
            called = true;
        },
    }), /protected catalogue publication failed/);
    assert.equal(called, false);
    await appSecretAbsent(value.appDirectory);
});

test('cleans App material when publication fails', async () => {
    const value = await fixture();

    await assert.rejects(runProtectedPublication({
        cwd: value.cwd,
        env: value.env,
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: value.fingerprint,
        stdout: {write: () => {}},
        tokenImpl: async () => ({
            token: 'opaque-synthetic-token',
            expiresAt: '2026-08-29T01:00:00.000Z',
        }),
        publishImpl: async () => {
            throw new Error('synthetic publication conflict');
        },
    }), /protected catalogue publication failed/);
    await appSecretAbsent(value.appDirectory);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
