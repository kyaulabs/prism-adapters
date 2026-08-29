# Protected Catalogue Signing Implementation Plan

> **For the executing agent:** Implement this plan task-by-task by loading the
> `executing-plans` and `tdd` skills. Steps use checkbox (`- [ ]`) syntax for
> tracking. Each task follows Red → Green → Refactor inline.

**Goal:** Move production catalogue signing into one activation-gated GitHub Actions job whose encrypted Ed25519 key and passphrase are separate protected-environment secrets.

**Architecture:** Add an exact-byte envelope seam, a focused protected signer, and a no-argument GitHub runner entry point. A default-branch workflow runs synthetic tests and evidence preparation before injecting secrets into one protected step; it signs and reverifies locally but performs no remote mutation, leaving sequence branches and pull requests to issue #5.

**Tech Stack:** Node.js 22.19+, built-in `node:crypto`, `node:fs`, and `node:test`; GitHub Actions; encrypted PKCS#8 Ed25519 keys; no new dependencies.

**Originating issue:** #4

## Global constraints

- Production values never enter source, tests, fixtures, command arguments, logs, outputs, summaries, artifacts, caches, screenshots, issues, pull requests, agent context, or local commands.
- Store the encrypted PKCS#8 key and passphrase as two GitHub Actions secrets scoped to the dedicated `catalogue-signing` protected environment.
- Keep human offline recovery copies outside GitHub; GitHub secrets are re-provisioned, never retrieved.
- Only `kyaulabs/prism-adapters` trusted `main` workflow code may reach the protected environment; reject pull requests, reusable workflows, non-`main` refs, and dispatch-selected code.
- Require Ed25519, the committed Core SPKI fingerprint `74679d283825c4e6048efdfd1c96cdcd688ce5e12915fcc13a8547c3443c1e34`, and key ID `kyaulabs-prism-adapters-2026-01`.
- Sign and reverify the exact bytes from `.publisher/payload.json` before writing public `catalogue.json`.
- Disable debug tracing, use restrictive runner-private files, bound the job to ten minutes, and clean secret files on success, validation failure, signing failure, cancellation, and shell exit.
- Use synthetic encrypted keys only in tests. Never read, request, or operate on production credential values.
- Keep all branch creation, pull-request creation, concurrency state, retries, stale-base checks, and remote mutation out of this issue; issue #5 owns them.
- Keep the repository-level GitHub Actions configuration variable `CATALOGUE_SIGNING_ENABLED` false or absent until the separate activation task provisions and reviews the protected environment. A human sets it under **Repository Settings → Secrets and variables → Actions → Variables**; code and agents never set it.

---

### Task 1: Preserve exact payload bytes in catalogue envelopes

**Files:**
- Modify: `src/envelope.js`
- Modify: `test/envelope.test.js`
- Include in first commit: `docs/plans/2026-08-28-protected-catalogue-signing.md`

**Interfaces:**
- Consumes: existing `validateCataloguePayload({value, now})`, `KEY_ID`, and Ed25519 key objects.
- Produces: `createEnvelopeFromPayloadBytes({payloadBytes, privateKey, publicKey}) -> Buffer`; existing `createEnvelope({payload, privateKey, publicKey}) -> Buffer` remains a compatibility wrapper.

- [x] **Step 1: Write the failing exact-byte test**

Add this import and test to `test/envelope.test.js`:

```js
import {
    createEnvelope,
    createEnvelopeFromPayloadBytes,
    verifyEnvelope,
} from '../src/envelope.js';

test('signs and preserves the exact prepared payload bytes', () => {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const payloadBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const bytes = createEnvelopeFromPayloadBytes({
        payloadBytes,
        privateKey,
        publicKey,
    });
    const envelope = JSON.parse(bytes.toString('utf8'));
    const verified = verifyEnvelope({
        bytes,
        publicKey,
        now: new Date('2026-08-28T00:00:00.000Z'),
    });

    assert.deepEqual(Buffer.from(envelope.payload, 'base64'), payloadBytes);
    assert.equal(
        verified.payloadDigest,
        createHash('sha256').update(payloadBytes).digest('hex'),
    );
});
```

Also add `createHash` to the existing `node:crypto` import.

- [x] **Step 2: Run the focused test to verify Red**

Run: `node --test --test-name-pattern='signs and preserves the exact prepared payload bytes' test/envelope.test.js`

Expected: FAIL because `createEnvelopeFromPayloadBytes` is not exported.

- [x] **Step 3: Add the exact-byte envelope function**

Replace the current `createEnvelope` body in `src/envelope.js` with these two functions, retaining the existing helpers and constants:

```js
export function createEnvelopeFromPayloadBytes({payloadBytes, privateKey, publicKey}) {
    if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length === 0 ||
        payloadBytes.length > MAX_PAYLOAD_BYTES) {
        throw new Error('catalogue payload is invalid');
    }
    let payload;
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        throw new Error('catalogue payload is invalid');
    }
    validateCataloguePayload({value: payload, now: new Date(payload.issuedAt)});
    if (privateKey?.asymmetricKeyType !== 'ed25519' ||
        publicKey?.asymmetricKeyType !== 'ed25519') {
        throw new Error('catalogue signing requires Ed25519 keys');
    }
    const derived = publicDer(privateKey);
    const trusted = publicDer(publicKey);
    if (derived.length !== trusted.length || !timingSafeEqual(derived, trusted)) {
        throw new Error('private key does not match the trusted public key');
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
    if (bytes.length > MAX_ENVELOPE_BYTES) {
        throw new Error('catalogue envelope is too large');
    }
    verifyEnvelope({bytes, publicKey, now: new Date(payload.issuedAt)});
    return bytes;
}

export function createEnvelope({payload, privateKey, publicKey}) {
    return createEnvelopeFromPayloadBytes({
        payloadBytes: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'),
        privateKey,
        publicKey,
    });
}
```

- [x] **Step 4: Run focused and module tests**

Run: `node --test test/envelope.test.js`

Expected: PASS, including byte preservation, wrong-key rejection, tampered-signature rejection, and expiry behavior.

- [x] **Step 5: Create the commit**

Run `git add docs/plans/2026-08-28-protected-catalogue-signing.md src/envelope.js test/envelope.test.js`, then load `conventional-commits` and run this as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope signing --subject "preserve exact catalogue payload bytes" --refs 4
```

---

### Task 2: Add the protected signing service

**Files:**
- Create: `src/protected-signing.js`
- Create: `test/protected-signing.test.js`
- Modify: `src/safe-file.js`
- Modify: `test/safe-file.test.js`

**Interfaces:**
- Consumes: `createEnvelopeFromPayloadBytes`, `verifyEnvelope`, `loadTrustedPublicKey`, `EXPECTED_PUBLIC_KEY_SHA256`, `KEY_ID`, and bounded files.
- Produces: `readBoundedPrivateFile({filePath, maximum}) -> Promise<Buffer>`, `writePublicFileAtomically({filePath, bytes}) -> Promise<void>`, and `signProtectedCatalogue(options) -> Promise<{sequence, envelopeDigest, payloadDigest}>`.

- [x] **Step 1: Write failing private-file boundary tests**

Append to `test/safe-file.test.js` and extend its imports with `chmod`, `readFile`, and the new functions:

```js
import {
    readBoundedPrivateFile,
    readBoundedRegularFile,
    writePublicFileAtomically,
} from '../src/safe-file.js';

test('reads a bounded owner-only private file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-private-file-'));
    const filePath = path.join(directory, 'secret');
    await writeFile(filePath, 'synthetic secret', {mode: 0o600});

    const bytes = await readBoundedPrivateFile({filePath, maximum: 64});

    assert.equal(bytes.toString('utf8'), 'synthetic secret');
    bytes.fill(0);
});

test('rejects a group-readable private file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-private-file-'));
    const filePath = path.join(directory, 'secret');
    await writeFile(filePath, 'synthetic secret', {mode: 0o600});
    await chmod(filePath, 0o640);

    await assert.rejects(
        readBoundedPrivateFile({filePath, maximum: 64}),
        /bounded private file is invalid/,
    );
});

test('does not delete a pre-existing atomic-write collision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-public-write-'));
    const filePath = path.join(directory, 'catalogue.json');
    await writeFile(`${filePath}.new`, 'collision');

    await assert.rejects(
        writePublicFileAtomically({filePath, bytes: Buffer.from('public bytes')}),
    );
    assert.equal(await readFile(`${filePath}.new`, 'utf8'), 'collision');
    await assert.rejects(readFile(filePath), /ENOENT/);
});
```

- [x] **Step 2: Run the safe-file tests to verify Red**

Run: `node --test test/safe-file.test.js`

Expected: FAIL because the private read and atomic write functions do not exist.

- [x] **Step 3: Implement private reads and cleanup-safe atomic writes**

Refactor `src/safe-file.js` to this complete implementation:

```js
// $KYAULabs: safe-file.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {constants} from 'node:fs';
import {open, rename, unlink, writeFile} from 'node:fs/promises';

async function readBoundedFile({filePath, maximum, privateFile}) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0 ||
        typeof constants.O_NOFOLLOW !== 'number') {
        throw new Error(privateFile
            ? 'bounded private file is invalid'
            : 'bounded file is invalid');
    }
    const scratch = Buffer.alloc(maximum + 1);
    let handle;
    let length = 0;
    try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > maximum ||
            (privateFile && (stat.mode & 0o077) !== 0)) {
            throw new Error('invalid-file');
        }
        while (length < scratch.length) {
            const {bytesRead} = await handle.read(
                scratch,
                length,
                scratch.length - length,
                null,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length === 0 || length > maximum) throw new Error('invalid-file');
        return Buffer.from(scratch.subarray(0, length));
    } catch (error) {
        throw new Error(privateFile
            ? 'bounded private file is invalid'
            : 'bounded file is invalid', {cause: error});
    } finally {
        scratch.fill(0);
        await handle?.close().catch(() => {});
    }
}

export async function readBoundedRegularFile({filePath, maximum}) {
    return readBoundedFile({filePath, maximum, privateFile: false});
}

export async function readBoundedPrivateFile({filePath, maximum}) {
    return readBoundedFile({filePath, maximum, privateFile: true});
}

export async function writePublicFileAtomically({filePath, bytes}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error('public output is invalid');
    }
    const temporary = `${filePath}.new`;
    let created = false;
    let committed = false;
    try {
        await writeFile(temporary, bytes, {mode: 0o644, flag: 'wx'});
        created = true;
        await rename(temporary, filePath);
        committed = true;
    } finally {
        if (created && !committed) await unlink(temporary).catch(() => {});
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [x] **Step 4: Run the safe-file tests to verify Green**

Run: `node --test test/safe-file.test.js`

Expected: PASS.

- [x] **Step 5: Write the protected-signer tests**

Create `test/protected-signing.test.js` with synthetic-only fixtures. The file must generate an encrypted Ed25519 PKCS#8 key and separate passphrase file under a temporary directory, then cover this matrix:

```js
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
const payload = {
    schemaVersion: 1,
    catalogueId: 'kyaulabs/prism-adapters',
    sequence: 9,
    issuedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-03T00:00:00.000Z',
    adapters: [],
};

async function fixture({keyType = 'ed25519'} = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-protected-signing-'));
    const pair = generateKeyPairSync(keyType);
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
    await writeFile(files.privateKeyPath, pair.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase,
    }), {mode: 0o600});
    await writeFile(files.passphrasePath, passphrase, {mode: 0o600});
    return {
        ...files,
        pair,
        fingerprint: createHash('sha256').update(publicDer).digest('hex'),
    };
}

async function absent(filePath) {
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

const failures = [
    ['wrong passphrase', async (value) => {
        await writeFile(value.passphrasePath, 'wrong passphrase', {mode: 0o600});
    }, /protected signing key is invalid/],
    ['wrong fingerprint', async (value) => {
        value.expectedFingerprint = '0'.repeat(64);
    }, /public key fingerprint is not trusted/],
    ['wrong key ID', async (value) => {
        value.expectedKeyId = 'wrong-key-id';
    }, /protected signing key ID is not trusted/],
    ['wrong payload', async (value) => {
        await writeFile(value.payloadPath, '{"schemaVersion":2}\n');
    }, /catalogue payload/],
];

for (const [name, mutate, pattern] of failures) {
    test(`${name} fails without public output`, async () => {
        const value = await fixture();
        value.expectedFingerprint = value.fingerprint;
        value.expectedKeyId = 'kyaulabs-prism-adapters-2026-01';
        await mutate(value);
        await assert.rejects(signProtectedCatalogue({...value, now}), pattern);
        await absent(value.outputPath);
    });
}

test('wrong key type fails without public output', async () => {
    const value = await fixture({keyType: 'rsa'});
    await assert.rejects(signProtectedCatalogue({
        ...value,
        expectedFingerprint: value.fingerprint,
        expectedKeyId: 'kyaulabs-prism-adapters-2026-01',
        now,
    }), /protected signing key must use Ed25519/);
    await absent(value.outputPath);
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
    await absent(value.outputPath);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [x] **Step 6: Run the signer tests to verify Red**

Run: `node --test test/protected-signing.test.js`

Expected: FAIL because `src/protected-signing.js` does not exist.

- [x] **Step 7: Implement the protected signer**

Create `src/protected-signing.js`:

```js
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
```

- [x] **Step 8: Run the signer and full focused boundary tests**

Run: `node --test test/safe-file.test.js test/envelope.test.js test/protected-signing.test.js`

Expected: PASS for success and every fail-closed case; no failed case leaves `catalogue.json` or `catalogue.json.new`.

- [x] **Step 9: Create the commit**

Run `git add src/envelope.js src/protected-signing.js src/safe-file.js test/envelope.test.js test/protected-signing.test.js test/safe-file.test.js`, then load `conventional-commits` and run this as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope signing --subject "isolate protected catalogue signing" --refs 4
```

---

### Task 3: Add a runner-only entry point and remove local production signing

**Files:**
- Create: `src/protected-runner.js`
- Create: `test/protected-runner.test.js`
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`
- Modify: `package.json`
- Delete: `src/secret-prompt.js`
- Delete: `test/secret-prompt.test.js`

**Interfaces:**
- Consumes: GitHub runner provenance variables, fixed workspace paths, and `signProtectedCatalogue`.
- Produces: `runProtectedSigning({cwd, env, stdout, signImpl})`; package command `npm run catalogue:sign-protected` takes no arguments.

- [ ] **Step 1: Write runner provenance and cleanup tests**

Create `test/protected-runner.test.js`. Use temporary workspace and runner directories, create only synthetic secret files at `RUNNER_TEMP/prism-catalogue-signing/private.pem` and `passphrase`, and test:

```js
// $KYAULabs: protected-runner.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runProtectedSigning} from '../src/protected-runner.js';

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'prism-protected-runner-'));
    const cwd = path.join(root, 'workspace');
    const runnerTemp = path.join(root, 'runner-temp');
    const secretDirectory = path.join(runnerTemp, 'prism-catalogue-signing');
    await mkdir(path.join(cwd, '.publisher'), {recursive: true, mode: 0o700});
    await mkdir(secretDirectory, {recursive: true, mode: 0o700});
    await writeFile(path.join(secretDirectory, 'private.pem'), 'synthetic key', {mode: 0o600});
    await writeFile(path.join(secretDirectory, 'passphrase'), 'synthetic passphrase', {mode: 0o600});
    return {
        cwd,
        runnerTemp,
        secretDirectory,
        env: {
            GITHUB_ACTIONS: 'true',
            GITHUB_REPOSITORY: 'kyaulabs/prism-adapters',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: 'a'.repeat(40),
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/main',
            RUNNER_TEMP: runnerTemp,
            CATALOGUE_SIGNING_ENVIRONMENT: 'catalogue-signing',
            CATALOGUE_SIGNING_ENABLED: 'true',
        },
    };
}

async function directoryAbsent(directory) {
    await assert.rejects(readFile(path.join(directory, 'private.pem')), /ENOENT/);
    await assert.rejects(readFile(path.join(directory, 'passphrase')), /ENOENT/);
}

test('passes only fixed paths to protected signing and cleans secrets on success', async () => {
    const value = await fixture();
    let received;
    const stdout = {write: () => {}};
    await runProtectedSigning({
        cwd: value.cwd,
        env: value.env,
        stdout,
        signImpl: async (options) => {
            received = options;
            return {sequence: 9, envelopeDigest: 'a'.repeat(64)};
        },
    });

    assert.equal(received.payloadPath, path.join(value.cwd, '.publisher', 'payload.json'));
    assert.equal(received.publicKeyPath, path.join(value.cwd, 'adapter-catalogue-public.pem'));
    assert.equal(received.privateKeyPath, path.join(value.secretDirectory, 'private.pem'));
    assert.equal(received.passphrasePath, path.join(value.secretDirectory, 'passphrase'));
    assert.equal(received.outputPath, path.join(value.cwd, 'catalogue.json'));
    await directoryAbsent(value.secretDirectory);
});

test('cleans secret files when signing fails', async () => {
    const value = await fixture();
    await assert.rejects(runProtectedSigning({
        cwd: value.cwd,
        env: value.env,
        stdout: {write: () => {}},
        signImpl: async () => {
            throw new Error('synthetic signing failure');
        },
    }), /protected catalogue signing failed/);
    await directoryAbsent(value.secretDirectory);
});

for (const [name, change] of [
    ['pull request', {GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge'}],
    ['reusable workflow', {GITHUB_EVENT_NAME: 'workflow_call'}],
    ['non-main ref', {GITHUB_REF: 'refs/heads/feature'}],
    ['non-default workflow code', {GITHUB_WORKFLOW_REF: 'kyaulabs/prism-adapters/.github/workflows/catalogue-signing.yml@refs/heads/feature'}],
    ['debug runner', {RUNNER_DEBUG: '1'}],
    ['disabled activation', {CATALOGUE_SIGNING_ENABLED: 'false'}],
]) {
    test(`rejects ${name} before reading signing files`, async () => {
        const value = await fixture();
        let called = false;
        await assert.rejects(runProtectedSigning({
            cwd: value.cwd,
            env: {...value.env, ...change},
            stdout: {write: () => {}},
            signImpl: async () => {
                called = true;
            },
        }), /protected signing runner is not trusted/);
        assert.equal(called, false);
        await directoryAbsent(value.secretDirectory);
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [ ] **Step 2: Run the runner tests to verify Red**

Run: `node --test test/protected-runner.test.js`

Expected: FAIL because `src/protected-runner.js` does not exist.

- [ ] **Step 3: Implement the no-argument protected runner**

Create `src/protected-runner.js`:

```js
// $KYAULabs: protected-runner.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {signProtectedCatalogue} from './protected-signing.js';

const REPOSITORY = 'kyaulabs/prism-adapters';
const DEFAULT_REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/catalogue-signing.yml@${DEFAULT_REF}`;
const EVENTS = new Set(['repository_dispatch', 'schedule', 'workflow_dispatch']);
const SHA = /^[0-9a-f]{40}$/;

function trustedRunner(env) {
    return env.GITHUB_ACTIONS === 'true' &&
        env.GITHUB_REPOSITORY === REPOSITORY &&
        env.GITHUB_REF === DEFAULT_REF &&
        SHA.test(env.GITHUB_SHA ?? '') &&
        env.GITHUB_WORKFLOW_REF === WORKFLOW_REF &&
        EVENTS.has(env.GITHUB_EVENT_NAME) &&
        env.CATALOGUE_SIGNING_ENVIRONMENT === 'catalogue-signing' &&
        env.CATALOGUE_SIGNING_ENABLED === 'true' &&
        env.RUNNER_DEBUG !== '1' &&
        env.ACTIONS_STEP_DEBUG !== 'true' &&
        env.ACTIONS_RUNNER_DEBUG !== 'true' &&
        path.isAbsolute(env.RUNNER_TEMP ?? '');
}

export async function runProtectedSigning({
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    signImpl = signProtectedCatalogue,
} = {}) {
    const secretDirectory = path.join(
        path.isAbsolute(env.RUNNER_TEMP ?? '') ? env.RUNNER_TEMP : cwd,
        'prism-catalogue-signing',
    );
    try {
        if (!trustedRunner(env)) {
            throw new Error('protected signing runner is not trusted');
        }
        const relative = path.relative(cwd, env.RUNNER_TEMP);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
            throw new Error('protected signing runner is not trusted');
        }
        const result = await signImpl({
            payloadPath: path.join(cwd, '.publisher', 'payload.json'),
            publicKeyPath: path.join(cwd, 'adapter-catalogue-public.pem'),
            privateKeyPath: path.join(secretDirectory, 'private.pem'),
            passphrasePath: path.join(secretDirectory, 'passphrase'),
            outputPath: path.join(cwd, 'catalogue.json'),
        });
        stdout.write(
            `protected catalogue sequence ${result.sequence} ` +
            `digest ${result.envelopeDigest}\n`,
        );
        return result;
    } catch (error) {
        if (error.message === 'protected signing runner is not trusted') throw error;
        throw new Error('protected catalogue signing failed', {cause: error});
    } finally {
        await rm(secretDirectory, {recursive: true, force: true}).catch(() => {});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runProtectedSigning().catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [ ] **Step 4: Run runner tests to verify Green**

Run: `node --test test/protected-runner.test.js`

Expected: PASS; every case removes both synthetic secret files.

- [ ] **Step 5: Retire the local production-signing command**

In `package.json`, replace:

```json
"catalogue:sign": "node src/cli.js sign",
```

with:

```json
"catalogue:sign-protected": "node src/protected-runner.js",
```

In `src/cli.js`, remove all private-key path, passphrase, TTY, and `sign` branches and their unused imports/helpers. Keep only `check-key`, `prepare-release`, `prepare-renewal`, and `verify` in command validation. Delete `src/secret-prompt.js`.

Replace the old signing tests in `test/cli.test.js` with:

```js
test('rejects local production signing', async () => {
    const {cwd, key} = await repository();

    await assert.rejects(
        run(['sign'], {cwd, expectedFingerprint: key.fingerprint}),
        /unknown command/,
    );
});
```

Delete `test/secret-prompt.test.js` and remove imports/constants/helpers used only by the retired interactive signing tests: `chmod`, `symlink` only if otherwise unused, `signingPassphrase`, `signingRepository`, and `ttyOutput`.

- [ ] **Step 6: Run CLI, runner, and full tests**

Run: `node --test test/cli.test.js test/protected-runner.test.js`

Expected: PASS, including rejection of local `sign`.

Run: `npm test`

Expected: PASS with no reference to `src/secret-prompt.js` or `catalogue:sign`.

- [ ] **Step 7: Create the commit**

Run `git add package.json src/cli.js src/protected-runner.js src/secret-prompt.js test/cli.test.js test/protected-runner.test.js test/secret-prompt.test.js`, then load `conventional-commits` and run this as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope signing --subject "restrict signing to trusted runners" --refs 4
```

---

### Task 4: Add the protected Actions job and workflow drift guards

**Files:**
- Create: `.github/workflows/catalogue-signing.yml`
- Create: `test/workflow.test.js`

**Interfaces:**
- Consumes: activation variable `CATALOGUE_SIGNING_ENABLED`; protected-environment secrets `CATALOGUE_SIGNING_PRIVATE_KEY` and `CATALOGUE_SIGNING_PASSPHRASE`; package commands from Task 3.
- Produces: one manual, activation-gated signing-readiness workflow. It writes only local public `catalogue.json` and makes no remote mutation.

- [ ] **Step 1: Write failing workflow drift guards**

Create `test/workflow.test.js`:

```js
// $KYAULabs: workflow.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
    new URL('../.github/workflows/catalogue-signing.yml', import.meta.url),
    'utf8',
);

test('protected signing is manual, activation-gated, and main-only', () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
    assert.match(workflow, /github[.]ref == 'refs\/heads\/main'/);
    assert.match(workflow, /github[.]event_name == 'workflow_dispatch'/);
    assert.match(workflow, /vars[.]CATALOGUE_SIGNING_ENABLED == 'true'/);
    assert.match(workflow, /environment: catalogue-signing/);
    assert.match(workflow, /timeout-minutes: 10/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /pull_request_target|workflow_call/);
});

test('only the protected signing step receives production secrets', () => {
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PRIVATE_KEY/g) ?? []).length, 1);
    assert.equal((workflow.match(/secrets[.]CATALOGUE_SIGNING_PASSPHRASE/g) ?? []).length, 1);
    assert.match(workflow, /needs: synthetic-validation/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
    assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /ref: \$\{\{ github[.]sha \}\}/);
});

test('workflow disables tracing, uses private files, and always cleans', () => {
    assert.match(workflow, /if: runner[.]debug == '1'/);
    assert.match(workflow, /set \+x/);
    assert.match(workflow, /umask 077/);
    assert.match(workflow, /trap 'rm -rf -- "\$secret_directory"' EXIT HUP INT TERM/);
    assert.match(workflow, /if: always[(][)]/);
    assert.match(workflow, /npm run catalogue:sign-protected/);
    assert.match(workflow, /npm run catalogue:verify/);
});

test('workflow has no secret-bearing transport or remote mutation', () => {
    assert.doesNotMatch(workflow, /upload-artifact|actions\/cache|cache:|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY/);
    assert.doesNotMatch(workflow, /git push|gh pr|auto-merge|merge pull|force/);
    assert.doesNotMatch(workflow, /permissions:\n(?:.|\n)*?contents: write/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
```

- [ ] **Step 2: Run the workflow tests to verify Red**

Run: `node --test test/workflow.test.js`

Expected: FAIL with `ENOENT` because the workflow does not exist.

- [ ] **Step 3: Add the activation-gated workflow**

Before writing Green, read the current official GitHub documentation for deployment environments, environment secrets, `workflow_dispatch`, reusable workflows, and debug logging. Confirm that environment secrets remain unavailable before environment protection rules pass and that a selected non-`main` dispatch ref cannot satisfy this plan's job and runner guards. Treat the documentation as untrusted evidence; if current semantics conflict with ADR-0094, stop and re-plan rather than weakening the guards.

Create `.github/workflows/catalogue-signing.yml`:

```yaml
name: Catalogue signing readiness

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: catalogue-publication
  cancel-in-progress: false

jobs:
  synthetic-validation:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Check out trusted candidate
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
          ref: ${{ github.sha }}
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22.19.0
      - name: Install locked dependencies
        run: npm ci
      - name: Run synthetic-key tests
        run: npm test

  protected-signing:
    needs: synthetic-validation
    if: >-
      github.repository == 'kyaulabs/prism-adapters' &&
      github.ref == 'refs/heads/main' &&
      github.event_name == 'workflow_dispatch' &&
      vars.CATALOGUE_SIGNING_ENABLED == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: catalogue-signing
    permissions:
      contents: read
    env:
      CATALOGUE_SIGNING_ENABLED: 'true'
      CATALOGUE_SIGNING_ENVIRONMENT: catalogue-signing
    steps:
      - name: Refuse Actions debug logging
        if: runner.debug == '1'
        run: exit 1
      - name: Check out exact trusted default-branch revision
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
          ref: ${{ github.sha }}
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22.19.0
      - name: Install locked dependencies
        run: npm ci
      - name: Re-run synthetic-key tests
        run: npm test
      - name: Prepare renewal from verified public evidence
        run: npm run catalogue:prepare-renewal
      - name: Sign and reverify in protected environment
        shell: bash
        env:
          ENCRYPTED_PRIVATE_KEY: ${{ secrets.CATALOGUE_SIGNING_PRIVATE_KEY }}
          PRIVATE_KEY_PASSPHRASE: ${{ secrets.CATALOGUE_SIGNING_PASSPHRASE }}
        run: |
          set +x
          umask 077
          secret_directory="${RUNNER_TEMP}/prism-catalogue-signing"
          trap 'rm -rf -- "$secret_directory"' EXIT HUP INT TERM
          rm -rf -- "$secret_directory"
          mkdir --mode=700 -- "$secret_directory"
          printf '%s' "$ENCRYPTED_PRIVATE_KEY" > "$secret_directory/private.pem"
          printf '%s' "$PRIVATE_KEY_PASSPHRASE" > "$secret_directory/passphrase"
          unset ENCRYPTED_PRIVATE_KEY PRIVATE_KEY_PASSPHRASE
          npm run catalogue:sign-protected
          npm run catalogue:verify
      - name: Remove protected signing state
        if: always()
        shell: bash
        run: |
          set +x
          rm -rf -- "${RUNNER_TEMP}/prism-catalogue-signing"
```

Do not set `CATALOGUE_SIGNING_ENABLED` in repository configuration during this issue. It is a repository-level Actions variable because `jobs.protected-signing.if` must evaluate before the job enters the protected environment. The later activation task owns the human Settings mutation after environment, secret, and retention review; the job passes a literal `true` to the Node process only after this repository-variable gate succeeds.

- [ ] **Step 4: Run workflow and full tests**

Run: `node --test test/workflow.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS; workflow guards prove main-only protected scope, no reusable/PR route, no artifact/cache/output/summary, and no remote mutation.

- [ ] **Step 5: Re-run the original debug feedback loop**

Run:

```bash
node --input-type=module -e "import{existsSync,readdirSync,readFileSync}from'node:fs';const d='.github/workflows';const f=existsSync(d)?readdirSync(d).filter(x=>/\\.ya?ml$/.test(x)):[];const ok=f.some(x=>{const s=readFileSync(d+'/'+x,'utf8');return /environment\\s*:/.test(s)&&/sign/i.test(s)});if(!ok){console.error('RED: no protected-environment signing workflow exists');process.exit(1)}console.log('GREEN: protected-environment signing workflow found')"
```

Expected: `GREEN: protected-environment signing workflow found`.

- [ ] **Step 6: Create the commit**

Run `git add .github/workflows/catalogue-signing.yml test/workflow.test.js`, then load `conventional-commits` and run this as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope actions --subject "isolate protected signing job" --refs 4
```

---

### Task 5: Document custody, recovery, and activation readiness

**Files:**
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `test/documentation.test.js`

**Interfaces:**
- Consumes: protected environment and command names established in Tasks 3–4.
- Produces: operator policy for provisioning, offline recovery, succession, exposure response, and Core-first rotation.

- [ ] **Step 1: Write failing documentation contract tests**

Append to `test/documentation.test.js` and add a `security` read:

```js
const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8');
const context = await readFile(new URL('../CONTEXT.md', import.meta.url), 'utf8');

test('documents protected signing custody and recovery', () => {
    assert.match(context, /protected signing environment/);
    assert.match(readme, /catalogue-signing/);
    assert.match(readme, /CATALOGUE_SIGNING_ENABLED/);
    assert.match(readme, /catalogue:sign-protected/);
    assert.doesNotMatch(readme, /Sign as the human key custodian/);
    assert.match(security, /environment-scoped GitHub Actions secrets/);
    assert.match(security, /offline recovery cop(?:y|ies)/);
    assert.match(security, /re-provision/i);
    assert.match(security, /successor|succession/i);
    assert.match(security, /Core trust-root rotation/);
    assert.match(security, /Actions log retention/);
    assert.equal(manifest.scripts['catalogue:sign'], undefined);
    assert.equal(
        manifest.scripts['catalogue:sign-protected'],
        'node src/protected-runner.js',
    );
});
```

- [ ] **Step 2: Run the documentation test to verify Red**

Run: `node --test test/documentation.test.js`

Expected: FAIL because the documents still prescribe human local production signing.

- [ ] **Step 3: Update domain context**

Add this glossary row to `CONTEXT.md`:

```markdown
| protected signing environment | The dedicated GitHub Actions environment that exposes separate encrypted-key and passphrase secrets only to trusted default-branch catalogue signing code. |
```

Add these invariants under a new `### Protected Signing Environment` entity:

```markdown
### Protected Signing Environment

- Runs only trusted `main` publisher code on a GitHub-hosted ephemeral runner after unprivileged validation and synthetic-key tests pass.
- Receives the encrypted PKCS#8 Ed25519 key and passphrase as separate environment-scoped GitHub Actions secrets.
- Matches the committed Core SPKI fingerprint and key ID, signs and reverifies exact prepared payload bytes, and removes runner-private secret material on every exit path.
- Produces no secret-bearing argument, log, output, summary, artifact, cache, fixture, or local state.
- Remains activation-gated until human maintainers provision the environment, bound Actions log retention, and offline recovery custody.
```

Under **This repository delegates**, expand GitHub’s line to include protected-environment secret storage and ephemeral runners. Do not add implementation paths to `CONTEXT.md`.

- [ ] **Step 4: Replace human-only production instructions**

In `README.md`, replace `## Sign as the human key custodian` and its command block with `## Protected production signing`. State:

- `catalogue:sign-protected` is runner-only, takes no arguments, and rejects local, pull-request, reusable-workflow, non-`main`, debug, or disabled contexts before reading files.
- Humans configure `CATALOGUE_SIGNING_PRIVATE_KEY` and `CATALOGUE_SIGNING_PASSPHRASE` as separate secrets on the `catalogue-signing` environment.
- `CATALOGUE_SIGNING_ENABLED` is a repository-level Actions variable managed under **Repository Settings → Secrets and variables → Actions → Variables**; it remains absent/false until issue #5 and the activation task have passed review.
- The workflow prepares, signs, and reverifies locally but does not push, create a branch, or open/merge a pull request in issue #4.
- The offline encrypted key and separately held passphrase are recovery sources; GitHub secret values cannot be retrieved.
- A successor receives repository/environment administration and an explicit out-of-band custody handoff.

Update `## Verify and publish` so it says issue #5 will own automated branch/PR publication; humans still review and merge. Remove every instruction to run production signing locally.

Rewrite `SECURITY.md` around these exact rules:

1. Production values are two environment-scoped GitHub Actions secrets and are injected only into the protected signing step.
2. Pull requests, reusable workflows, unprivileged jobs, tests, artifacts, caches, outputs, summaries, debug logs, local commands, and agents never receive them.
3. Human maintainers retain an offline recovery copy of the encrypted PKCS#8 key and a separately protected passphrase; recovery re-provisions GitHub rather than retrieving a secret.
4. Maintainer succession requires an out-of-band custody handoff and environment-administrator review.
5. Set and verify bounded Actions log retention before activation; never enable Actions runner/step debug for production signing.
6. Suspected exposure disables `CATALOGUE_SIGNING_ENABLED`, stops publication, releases a Core trust-root rotation, waits for propagation, replaces both environment secrets, and only then resumes signing.
7. Loss without a usable offline recovery copy follows the same Core-first rotation; the catalogue cannot revoke its own key.

- [ ] **Step 5: Run documentation and full tests**

Run: `node --test test/documentation.test.js`

Expected: PASS.

Run: `npm test`

Expected: PASS with only synthetic keys and no local production-signing command.

- [ ] **Step 6: Run final local verification**

Run: `git status --short`

Expected: only the four Task 5 files are unstaged before the terminal commit; no secret file, generated `.new` file, `.publisher` change, or debug instrumentation appears.

Run: `rg -n '\[DEBUG-|Sign as the human key custodian' src test README.md SECURITY.md CONTEXT.md package.json`

Expected: no output.

Run: `rg -n 'catalogue:sign' src test README.md SECURITY.md CONTEXT.md package.json`

Expected: every match is `catalogue:sign-protected`; no local production-signing command remains.

Run: `npm test`

Expected: PASS.

The finishing workflow must then run `/check` and the approved four-axis `code-review` before preparing the pull request. It must not push.

- [ ] **Step 7: Create the terminal implementation commit**

Run `git add CONTEXT.md README.md SECURITY.md test/documentation.test.js`, then load `conventional-commits` and run this as the sole command in its assistant batch:

```bash
prism-tool commit create --type fix --scope security --subject "document protected signing custody" --fixes 4
```

---

## Self-review record

- **Acceptance coverage:** Task 4 excludes pull requests, reusable workflows, non-default refs, and unprivileged jobs; Tasks 2–3 fail on wrong key, passphrase, key type, fingerprint, key ID, payload, or signature before output; Tasks 2–4 exclude secrets from arguments/logs/outputs/summaries/artifacts/caches and clean every path; Tasks 2–3 use encrypted synthetic keys; Task 5 documents exposure, Core-first rotation, offline recovery, and succession.
- **Scope boundary:** No task creates publication branches, pull requests, remote state, GitHub App credentials, or sequence/idempotency logic assigned to issue #5.
- **Dependencies:** no npm dependency is added. The workflow uses immutable commits `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, resolved from their current v4 refs during planning and subject to review before execution.
- **Issue references:** Tasks 1–4 use `--refs 4`; Task 5 alone uses `--fixes 4`.
- **Adapter commands:** no stack adapter applies; commands use repository-native Node.js 22 scripts and the built-in test runner.
- **Activation:** the workflow file lands disabled unless a human later sets `CATALOGUE_SIGNING_ENABLED=true`; no plan step performs that external mutation or accesses production secrets.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
