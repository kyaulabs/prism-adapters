// $KYAULabs: commit-signing-policy.test.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    COMMIT_SIGNING_POLICY,
    verifyCommitSigningPublicExport,
} from '../src/commit-signing-policy.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicKeyPath = path.join(root, 'publication-commit-signing-public.asc');

test('pins the production publication commit-signing identity', async () => {
    assert.deepEqual(COMMIT_SIGNING_POLICY, Object.freeze({
        name: 'kyaulabs-bot',
        email: 'actions@kyaulabs.com',
        primaryFingerprint: '646340DAD3387E48F047B5C049659B98769C17D6',
        signingFingerprint: '0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE',
        publicExportSha256: 'aa56c5d1c6dec3ef090f9551315097980fc222e6bc4b304a3facc382707249a3',
    }));
    await verifyCommitSigningPublicExport({filePath: publicKeyPath});
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
