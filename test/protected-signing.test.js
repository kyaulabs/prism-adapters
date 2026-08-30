// $KYAULabs: protected-signing.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createEnvelopeFromPayloadBytes} from '../src/envelope.js';
import {signProtectedCatalogue} from '../src/protected-signing.js';

const now = new Date('2026-08-28T00:00:00.000Z');
const passphrase = 'synthetic protected signing passphrase';
const integrity = `sha512-${Buffer.alloc(64, 41).toString('base64')}`;
const payload = {
    schemaVersion: 1,
    catalogueId: 'kyaulabs/prism-adapters',
    sequence: 9,
    issuedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-03T00:00:00.000Z',
    adapters: [{
        id: 'php-web',
        displayName: 'PHP/web',
        packageName: '@kyaulabs/prism-php-web',
        releases: [{
            version: '0.4.1',
            coreRange: '>=0.4.1 <0.5.0',
            bootstrapProtocol: 1,
            integrity,
            publishedAt: '2026-08-27T12:00:00.000Z',
            status: 'ACTIVE',
        }],
    }],
};

async function fixture({encrypted = true, privateKeyType = 'ed25519'} = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-protected-signing-'));
    const pair = generateKeyPairSync('ed25519');
    const signingPair = privateKeyType === 'ed25519'
        ? pair
        : generateKeyPairSync(privateKeyType, {modulusLength: 2048});
    const publicDer = pair.publicKey.export({type: 'spki', format: 'der'});
    const files = {
        payloadPath: path.join(directory, 'payload.json'),
        publicKeyPath: path.join(directory, 'public.pem'),
        privateKeyPath: path.join(directory, 'private.pem'),
        passphrasePath: path.join(directory, 'passphrase'),
        outputPath: path.join(directory, 'catalogue.json'),
    };
    await writeFile(files.payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    await writeFile(
        files.publicKeyPath,
        pair.publicKey.export({type: 'spki', format: 'pem'}),
    );
    const exportOptions = {type: 'pkcs8', format: 'pem'};
    if (encrypted) {
        exportOptions.cipher = 'aes-256-cbc';
        exportOptions.passphrase = passphrase;
    }
    await writeFile(
        files.privateKeyPath,
        signingPair.privateKey.export(exportOptions),
        {mode: 0o600},
    );
    await writeFile(files.passphrasePath, passphrase, {mode: 0o600});
    return {
        ...files,
        pair,
        fingerprint: createHash('sha256').update(publicDer).digest('hex'),
    };
}

async function outputAbsent(filePath) {
    await assert.rejects(readFile(filePath), /ENOENT/);
    await assert.rejects(readFile(`${filePath}.new`), /ENOENT/);
}

test('signs and reverifies exact payload bytes with an encrypted synthetic key', async () => {
    const value = await fixture();
    const result = await signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    });
    const envelope = JSON.parse(await readFile(value.outputPath, 'utf8'));

    assert.deepEqual(
        Buffer.from(envelope.payload, 'base64'),
        await readFile(value.payloadPath),
    );
    assert.equal(result.sequence, 9);
    assert.match(result.envelopeDigest, /^[0-9a-f]{64}$/);
});

test('wrong passphrase fails without public output', async () => {
    const value = await fixture();
    await writeFile(value.passphrasePath, 'wrong passphrase', {mode: 0o600});

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /protected signing key is invalid/);
    await outputAbsent(value.outputPath);
});

test('wrong fingerprint fails without public output', async () => {
    const value = await fixture();

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: '0'.repeat(64),
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /public key fingerprint is not trusted/);
    await outputAbsent(value.outputPath);
});

test('wrong key ID fails without public output', async () => {
    const value = await fixture();

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'wrong-key-id',
        now,
    }), /protected signing key ID is not trusted/);
    await outputAbsent(value.outputPath);
});

test('wrong payload fails without public output', async () => {
    const value = await fixture();
    await writeFile(value.payloadPath, '{"schemaVersion":2}\n');

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /catalogue payload/);
    await outputAbsent(value.outputPath);
});

test('wrong private-key type fails without public output', async () => {
    const value = await fixture({privateKeyType: 'rsa'});

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /protected signing key must use Ed25519/);
    await outputAbsent(value.outputPath);
});

test('failed envelope reverification leaves no public output', async () => {
    const value = await fixture();
    const corruptEnvelope = (options) => {
        const bytes = createEnvelopeFromPayloadBytes(options);
        const envelope = JSON.parse(bytes.toString('utf8'));
        envelope.signature = Buffer.alloc(64).toString('base64');
        return Buffer.from(`${JSON.stringify(envelope)}\n`);
    };

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
        createEnvelopeImpl: corruptEnvelope,
    }), /catalogue signature is invalid/);
    await outputAbsent(value.outputPath);
});

test('unencrypted PKCS8 fails without public output', async () => {
    const value = await fixture({encrypted: false});

    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /protected signing key must be encrypted PKCS8/);
    await outputAbsent(value.outputPath);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
