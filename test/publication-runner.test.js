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
    await mkdir(path.join(cwd, '.publisher'), {mode: 0o700});
    const signing = generateKeyPairSync('ed25519');
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
    return {
        cwd,
        runnerTemp,
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
            CATALOGUE_PUBLICATION_TOKEN: 'opaque-synthetic-publication-credential',
        },
    };
}

test('reverifies and publishes only the fixed protected catalogue candidate', async () => {
    const value = await fixture();
    let publication;
    let output = '';

    const result = await runProtectedPublication({
        cwd: value.cwd,
        env: value.env,
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: value.fingerprint,
        stdout: {write: (chunk) => { output += chunk; }},
        publishImpl: async (input) => {
            publication = input;
            return {
                state: 'IDEMPOTENT',
                branchName: 'catalogue/sequence-8',
                pullRequestNumber: 17,
            };
        },
    });

    assert.deepEqual(publication.intent, {
        baseSha: value.baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(value.sourceBytes),
        envelopeDigest: sha256(value.envelopeBytes),
    });
    assert.deepEqual(publication.sourceBytes, value.sourceBytes);
    assert.deepEqual(publication.envelopeBytes, value.envelopeBytes);
    assert.equal(publication.token, 'opaque-synthetic-publication-credential');
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
    assert.doesNotMatch(output, /opaque-synthetic-publication-credential/);
});

for (const [name, change] of [
    ['local execution', {GITHUB_ACTIONS: 'false'}],
    ['non-main ref', {GITHUB_REF: 'refs/heads/feature'}],
    ['wrong workflow', {
        GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/other.yml@refs/heads/main',
    }],
    ['debug logging', {RUNNER_DEBUG: '1'}],
]) {
    test(`rejects ${name} before publication`, async () => {
        const value = await fixture();
        let called = false;

        await assert.rejects(runProtectedPublication({
            cwd: value.cwd,
            env: {...value.env, ...change},
            now: new Date('2026-08-29T00:00:00.000Z'),
            expectedFingerprint: value.fingerprint,
            stdout: {write: () => {}},
            publishImpl: async () => {
                called = true;
            },
        }), /protected publication runner is not trusted/);
        assert.equal(called, false);
    });
}

test('rejects mismatched trigger and signed output before publication', async () => {
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
        publishImpl: async () => {
            called = true;
        },
    }), /protected catalogue publication failed/);
    assert.equal(called, false);
});

test('rejects an absent publication credential before publication', async () => {
    const value = await fixture();
    const env = {...value.env};
    delete env.CATALOGUE_PUBLICATION_TOKEN;
    let called = false;

    await assert.rejects(runProtectedPublication({
        cwd: value.cwd,
        env,
        now: new Date('2026-08-29T00:00:00.000Z'),
        expectedFingerprint: value.fingerprint,
        stdout: {write: () => {}},
        publishImpl: async () => {
            called = true;
        },
    }), /protected catalogue publication failed/);
    assert.equal(called, false);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
