// $KYAULabs: protected-signing.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {createHash, createPrivateKey} from 'node:crypto';

import {
    createEnvelopeFromPayloadBytes,
    verifyEnvelope,
} from './envelope.js';
import {
    EXPECTED_PUBLIC_KEY_SHA256,
    KEY_ID,
    loadTrustedPublicKey,
} from './public-key.js';
import {
    readBoundedPrivateFile,
    readBoundedRegularFile,
    writePublicFileAtomically,
} from './safe-file.js';

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_PRIVATE_KEY_BYTES = 65_536;
const MAX_PASSPHRASE_BYTES = 4096;
const ENCRYPTED_PKCS8 = Buffer.from('-----BEGIN ENCRYPTED PRIVATE KEY-----');

export async function signProtectedCatalogue({
    payloadPath,
    publicKeyPath,
    privateKeyPath,
    passphrasePath,
    outputPath,
    expectedFingerprint = EXPECTED_PUBLIC_KEY_SHA256,
    expectedKeyId = KEY_ID,
    now = new Date(),
    createEnvelopeImpl = createEnvelopeFromPayloadBytes,
    verifyEnvelopeImpl = verifyEnvelope,
}) {
    if (expectedKeyId !== KEY_ID) {
        throw new Error('protected signing key ID is not trusted');
    }
    const publicKey = await loadTrustedPublicKey({
        filePath: publicKeyPath,
        expectedFingerprint,
    });
    const payloadBytes = await readBoundedRegularFile({
        filePath: payloadPath,
        maximum: MAX_PAYLOAD_BYTES,
    });
    let privateKeyBytes;
    let passphraseBytes;
    let privateKey;
    try {
        privateKeyBytes = await readBoundedPrivateFile({
            filePath: privateKeyPath,
            maximum: MAX_PRIVATE_KEY_BYTES,
        });
        passphraseBytes = await readBoundedPrivateFile({
            filePath: passphrasePath,
            maximum: MAX_PASSPHRASE_BYTES,
        });
        if (privateKeyBytes.length < ENCRYPTED_PKCS8.length ||
            !privateKeyBytes.subarray(0, ENCRYPTED_PKCS8.length).equals(ENCRYPTED_PKCS8)) {
            throw new Error('protected signing key must be encrypted PKCS8');
        }
        try {
            privateKey = createPrivateKey({
                key: privateKeyBytes,
                format: 'pem',
                passphrase: passphraseBytes,
            });
        } catch {
            throw new Error('protected signing key is invalid');
        }
    } finally {
        privateKeyBytes?.fill(0);
        passphraseBytes?.fill(0);
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('protected signing key must use Ed25519');
    }
    const envelopeBytes = createEnvelopeImpl({
        payloadBytes,
        privateKey,
        publicKey,
    });
    const verified = verifyEnvelopeImpl({bytes: envelopeBytes, publicKey, now});
    const payloadDigest = createHash('sha256').update(payloadBytes).digest('hex');
    if (verified.keyId !== expectedKeyId || verified.payloadDigest !== payloadDigest) {
        throw new Error('protected catalogue verification failed');
    }
    await writePublicFileAtomically({filePath: outputPath, bytes: envelopeBytes});
    return Object.freeze({
        sequence: verified.catalogue.sequence,
        envelopeDigest: verified.envelopeDigest,
        payloadDigest,
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
