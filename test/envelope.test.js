// $KYAULabs: envelope.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';

import {createEnvelope, verifyEnvelope} from '../src/envelope.js';

const integrity = `sha512-${Buffer.alloc(64, 11).toString('base64')}`;
const payload = {
    schemaVersion: 1,
    catalogueId: 'kyaulabs/prism-adapters',
    sequence: 1,
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

test('creates an envelope that verifies with the matching public key', () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const bytes = createEnvelope({payload, privateKey, publicKey});
    const verified = verifyEnvelope({
        bytes,
        publicKey,
        now: new Date('2026-08-28T00:00:00.000Z'),
    });

    assert.equal(verified.catalogue.sequence, 1);
    assert.equal(verified.keyId, 'kyaulabs-prism-adapters-2026-01');
    assert.match(verified.envelopeDigest, /^[0-9a-f]{64}$/);
    assert.equal(bytes.at(-1), 0x0a);
});

test('rejects a private key that does not match the trusted public key', () => {
    const first = generateKeyPairSync('ed25519');
    const second = generateKeyPairSync('ed25519');

    assert.throws(
        () => createEnvelope({
            payload,
            privateKey: first.privateKey,
            publicKey: second.publicKey,
        }),
        /private key does not match the trusted public key/,
    );
});

test('rejects a tampered signature', () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const bytes = createEnvelope({payload, privateKey, publicKey});
    const envelope = JSON.parse(bytes.toString('utf8'));
    const signature = Buffer.from(envelope.signature, 'base64');
    signature[0] ^= 0xff;
    envelope.signature = signature.toString('base64');

    assert.throws(
        () => verifyEnvelope({
            bytes: Buffer.from(`${JSON.stringify(envelope)}\n`),
            publicKey,
            now: new Date('2026-08-28T00:00:00.000Z'),
        }),
        /catalogue signature is invalid/,
    );
});

test('rejects a future-issued envelope during sequence recovery', () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const futurePayload = {
        ...payload,
        issuedAt: '2026-08-28T12:00:00.000Z',
        expiresAt: '2026-09-03T12:00:00.000Z',
    };
    const bytes = createEnvelope({payload: futurePayload, privateKey, publicKey});

    assert.throws(
        () => verifyEnvelope({
            bytes,
            publicKey,
            now: new Date('2026-08-28T00:00:00.000Z'),
            allowExpired: true,
        }),
        /catalogue is not yet valid/,
    );
});

test('allows an expired signed envelope only for sequence recovery', () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const bytes = createEnvelope({payload, privateKey, publicKey});

    assert.throws(
        () => verifyEnvelope({
            bytes,
            publicKey,
            now: new Date('2026-09-04T00:00:00.000Z'),
        }),
        /catalogue is expired/,
    );
    const recovered = verifyEnvelope({
        bytes,
        publicKey,
        now: new Date('2026-09-04T00:00:00.000Z'),
        allowExpired: true,
    });
    assert.equal(recovered.catalogue.sequence, 1);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
