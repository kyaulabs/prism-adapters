// $KYAULabs: commit-signing-policy.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import {createHash} from 'node:crypto';

import {readBoundedRegularFile} from './safe-file.js';

const ARMOR_PREFIX = Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----');
const MAX_PUBLIC_EXPORT_BYTES = 65_536;

export const COMMIT_SIGNING_POLICY = Object.freeze({
    name: 'kyaulabs-bot',
    email: 'actions@kyaulabs.com',
    primaryFingerprint: '646340DAD3387E48F047B5C049659B98769C17D6',
    signingFingerprint: '0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE',
    publicExportSha256: 'aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3',
});

export async function verifyCommitSigningPublicExport({filePath}) {
    const bytes = await readBoundedRegularFile({
        filePath,
        maximum: MAX_PUBLIC_EXPORT_BYTES,
    });
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== COMMIT_SIGNING_POLICY.publicExportSha256 ||
        bytes.length < ARMOR_PREFIX.length ||
        !bytes.subarray(0, ARMOR_PREFIX.length).equals(ARMOR_PREFIX)) {
        throw new Error('publication commit-signing public key is not trusted');
    }
    return bytes;
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
