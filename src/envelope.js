// $KYAULabs: envelope.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {
    createHash,
    createPublicKey,
    sign,
    timingSafeEqual,
    verify,
} from 'node:crypto';

import {KEY_ID} from './public-key.js';
import {validateCataloguePayload} from './payload.js';

const MAX_ENVELOPE_BYTES = 1_398_104;
const MAX_PAYLOAD_BYTES = 1_048_576;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function canonicalBase64(value, maximum) {
    if (typeof value !== 'string' || !BASE64.test(value)) {
        throw new Error('catalogue envelope is invalid');
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0 || bytes.length > maximum || bytes.toString('base64') !== value) {
        throw new Error('catalogue envelope is invalid');
    }
    return bytes;
}

function publicDer(key) {
    const publicKey = key.type === 'public' ? key : createPublicKey(key);
    return publicKey.export({type: 'spki', format: 'der'});
}

export function createEnvelope({payload, privateKey, publicKey}) {
    if (privateKey?.asymmetricKeyType !== 'ed25519' || publicKey?.asymmetricKeyType !== 'ed25519') {
        throw new Error('catalogue signing requires Ed25519 keys');
    }
    const derived = publicDer(privateKey);
    const trusted = publicDer(publicKey);
    if (derived.length !== trusted.length || !timingSafeEqual(derived, trusted)) {
        throw new Error('private key does not match the trusted public key');
    }
    const payloadBytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    if (payloadBytes.length === 0 || payloadBytes.length > MAX_PAYLOAD_BYTES) {
        throw new Error('catalogue payload is too large');
    }
    const signature = sign(null, payloadBytes, privateKey);
    const envelope = {
        schemaVersion: 1,
        keyId: KEY_ID,
        algorithm: 'Ed25519',
        payload: payloadBytes.toString('base64'),
        signature: signature.toString('base64'),
    };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error('catalogue envelope is too large');
    verifyEnvelope({bytes, publicKey, now: new Date(payload.issuedAt)});
    return bytes;
}

export function verifyEnvelope({
    bytes,
    publicKey,
    now = new Date(),
    allowExpired = false,
}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
        throw new Error('catalogue envelope is invalid');
    }
    let envelope;
    try {
        envelope = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('catalogue envelope is invalid');
    }
    if (!exactKeys(envelope, [
        'schemaVersion', 'keyId', 'algorithm', 'payload', 'signature',
    ]) || envelope.schemaVersion !== 1 || envelope.keyId !== KEY_ID ||
        envelope.algorithm !== 'Ed25519') {
        throw new Error('catalogue envelope is invalid');
    }
    const payloadBytes = canonicalBase64(envelope.payload, MAX_PAYLOAD_BYTES);
    const signature = canonicalBase64(envelope.signature, 128);
    if (!verify(null, payloadBytes, publicKey, signature)) {
        throw new Error('catalogue signature is invalid');
    }
    let catalogue;
    try {
        catalogue = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        throw new Error('catalogue payload is invalid');
    }
    validateCataloguePayload({value: catalogue, now, allowExpired});
    return Object.freeze({
        keyId: envelope.keyId,
        catalogue,
        envelopeDigest: createHash('sha256').update(bytes).digest('hex'),
        payloadDigest: createHash('sha256').update(payloadBytes).digest('hex'),
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
