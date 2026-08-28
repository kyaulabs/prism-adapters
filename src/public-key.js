// $KYAULabs: public-key.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {createHash, createPublicKey} from 'node:crypto';

import {readBoundedRegularFile} from './safe-file.js';

export const CATALOGUE_ID = 'kyaulabs/prism-adapters';
export const KEY_ID = 'kyaulabs-prism-adapters-2026-01';
export const EXPECTED_PUBLIC_KEY_SHA256 =
    '74679d283825c4e6048efdfd1c96cdcd688ce5e12915fcc13a8547c3443c1e34';

const MAX_PUBLIC_KEY_BYTES = 16_384;
const SHA256 = /^[0-9a-f]{64}$/;

export async function loadTrustedPublicKey({
    filePath,
    expectedFingerprint = EXPECTED_PUBLIC_KEY_SHA256,
}) {
    if (!SHA256.test(expectedFingerprint)) {
        throw new Error('trusted public key fingerprint is invalid');
    }
    let bytes;
    try {
        bytes = await readBoundedRegularFile({
            filePath,
            maximum: MAX_PUBLIC_KEY_BYTES,
        });
    } catch {
        throw new Error('public key must be a regular non-symlink file');
    }
    let publicKey;
    try {
        publicKey = createPublicKey(bytes);
    } catch {
        throw new Error('public key is not valid PEM SPKI');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('public key must use Ed25519');
    }
    const der = publicKey.export({type: 'spki', format: 'der'});
    const fingerprint = createHash('sha256').update(der).digest('hex');
    if (fingerprint !== expectedFingerprint) {
        throw new Error('public key fingerprint is not trusted');
    }
    return publicKey;
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
