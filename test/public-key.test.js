// $KYAULabs: public-key.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    EXPECTED_PUBLIC_KEY_SHA256,
    loadTrustedPublicKey,
} from '../src/public-key.js';

function fixture() {
    const {publicKey} = generateKeyPairSync('ed25519');
    const der = publicKey.export({type: 'spki', format: 'der'});
    return {
        pem: publicKey.export({type: 'spki', format: 'pem'}),
        fingerprint: createHash('sha256').update(der).digest('hex'),
    };
}

test('accepts a regular Ed25519 SPKI public key with the expected fingerprint', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-adapters-key-'));
    const key = fixture();
    const filePath = path.join(directory, 'public.pem');
    await writeFile(filePath, key.pem, {mode: 0o644});

    const loaded = await loadTrustedPublicKey({
        filePath,
        expectedFingerprint: key.fingerprint,
    });

    assert.equal(loaded.asymmetricKeyType, 'ed25519');
});

test('rejects a public key whose fingerprint is not trusted', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-adapters-key-'));
    const key = fixture();
    const filePath = path.join(directory, 'public.pem');
    await writeFile(filePath, key.pem, {mode: 0o644});

    await assert.rejects(
        loadTrustedPublicKey({filePath, expectedFingerprint: '0'.repeat(64)}),
        /public key fingerprint is not trusted/,
    );
});

test('rejects a symlinked public key', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-adapters-key-'));
    const key = fixture();
    const target = path.join(directory, 'target.pem');
    const link = path.join(directory, 'public.pem');
    await writeFile(target, key.pem, {mode: 0o644});
    await symlink(target, link);

    await assert.rejects(
        loadTrustedPublicKey({filePath: link, expectedFingerprint: key.fingerprint}),
        /public key must be a regular non-symlink file/,
    );
});

test('the committed production public key matches the Core trust root', async () => {
    const loaded = await loadTrustedPublicKey({
        filePath: new URL('../adapter-catalogue-public.pem', import.meta.url),
        expectedFingerprint: EXPECTED_PUBLIC_KEY_SHA256,
    });

    assert.equal(loaded.asymmetricKeyType, 'ed25519');
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
