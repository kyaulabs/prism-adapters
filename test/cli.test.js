// $KYAULabs: cli.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {verifyEnvelope} from '../src/envelope.js';
import {run} from '../src/cli.js';

const integrity = `sha512-${Buffer.alloc(64, 19).toString('base64')}`;
const signingPassphrase = 'synthetic catalogue passphrase';

function payload() {
    return {
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
}

function keys() {
    const pair = generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({type: 'spki', format: 'der'});
    return {
        ...pair,
        fingerprint: createHash('sha256').update(der).digest('hex'),
        pem: pair.publicKey.export({type: 'spki', format: 'pem'}),
    };
}

function output() {
    let value = '';
    return {
        stream: {write: (chunk) => { value += chunk; }},
        value: () => value,
    };
}

async function repository() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-adapters-cli-'));
    const key = keys();
    await writeFile(path.join(cwd, 'adapter-catalogue-public.pem'), key.pem);
    await writeFile(path.join(cwd, 'catalogue-source.json'), JSON.stringify({
        schemaVersion: 1,
        adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.1',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }],
    }));
    return {cwd, key};
}

async function signingRepository({encrypted = true, signingKey = null} = {}) {
    const fixture = await repository();
    const homeDirectory = await mkdtemp(path.join(tmpdir(), 'prism-adapters-home-'));
    const key = signingKey ?? fixture.key.privateKey;
    const exportOptions = {type: 'pkcs8', format: 'pem'};
    if (encrypted) {
        exportOptions.cipher = 'aes-256-cbc';
        exportOptions.passphrase = signingPassphrase;
    }
    await writeFile(path.join(homeDirectory, 'private.pem'), key.export(exportOptions), {
        mode: 0o600,
    });
    await mkdir(path.join(fixture.cwd, '.publisher'), {mode: 0o700});
    await writeFile(
        path.join(fixture.cwd, '.publisher', 'payload.json'),
        `${JSON.stringify(payload())}\n`,
        {mode: 0o600},
    );
    return {...fixture, homeDirectory};
}

function ttyOutput() {
    const fixture = output();
    fixture.stream.isTTY = true;
    return fixture;
}

test('prepares sequence one without exposing signing-key authority', async () => {
    const {cwd, key} = await repository();
    const stdout = output();
    await run(['prepare'], {
        cwd,
        expectedFingerprint: key.fingerprint,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdout: stdout.stream,
        fetchImpl: async () => {
            const body = JSON.stringify({
                versions: {'0.4.1': {dist: {integrity}}},
                time: {'0.4.1': '2026-08-27T12:00:00.000Z'},
            });
            return new Response(body, {
                status: 200,
                headers: {'content-length': String(Buffer.byteLength(body))},
            });
        },
    });

    const payload = JSON.parse(await readFile(
        path.join(cwd, '.publisher', 'payload.json'),
        'utf8',
    ));
    assert.equal(payload.sequence, 1);
    assert.match(stdout.value(), /prepared catalogue sequence 1/);
    assert.match(stdout.value(), /digest [0-9a-f]{64}/);
});

test('sign rejects non-interactive execution before requesting a private key', async () => {
    const {cwd, key} = await repository();
    await mkdir(path.join(cwd, '.publisher'));
    await writeFile(path.join(cwd, '.publisher', 'payload.json'), '{}\n');

    await assert.rejects(
        run(['sign'], {
            cwd,
            expectedFingerprint: key.fingerprint,
            stdin: {isTTY: false},
            stdout: output().stream,
        }),
        /signing requires the human key custodian in an interactive terminal/,
    );
});

test('rejects an unconfirmed payload digest before requesting a key path', async () => {
    const fixture = await signingRepository();
    let pathRequested = false;
    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            payloadConfirmationPrompt: async () => false,
            privateKeyPathPrompt: async () => {
                pathRequested = true;
                return '~/private.pem';
            },
        }),
        /prepared payload digest was not confirmed/,
    );
    assert.equal(pathRequested, false);
});

test('signs with an encrypted PKCS8 key resolved from a tilde path', async () => {
    const fixture = await signingRepository();
    const stdout = ttyOutput();
    await run(['sign'], {
        cwd: fixture.cwd,
        expectedFingerprint: fixture.key.fingerprint,
        homeDirectory: fixture.homeDirectory,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdin: {isTTY: true},
        stdout: stdout.stream,
        payloadConfirmationPrompt: async () => true,
        privateKeyPathPrompt: async () => '~/private.pem',
        passphrasePrompt: async () => Buffer.from(signingPassphrase),
    });

    const bytes = await readFile(path.join(fixture.cwd, 'catalogue.json'));
    const verified = verifyEnvelope({
        bytes,
        publicKey: fixture.key.publicKey,
        now: new Date('2026-08-28T00:00:00.000Z'),
    });
    assert.equal(verified.catalogue.sequence, 1);
    assert.match(stdout.value(), /signed catalogue sequence 1/);
});

for (const supplied of ['$HOME/private.pem', '${HOME}/private.pem']) {
    test(`signs when the key path uses ${supplied.split('/')[0]}`, async () => {
        const fixture = await signingRepository();
        await run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            homeDirectory: fixture.homeDirectory,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            payloadConfirmationPrompt: async () => true,
            privateKeyPathPrompt: async () => supplied,
            passphrasePrompt: async () => Buffer.from(signingPassphrase),
        });
        const bytes = await readFile(path.join(fixture.cwd, 'catalogue.json'));
        assert.doesNotThrow(() => verifyEnvelope({
            bytes,
            publicKey: fixture.key.publicKey,
            now: new Date('2026-08-28T00:00:00.000Z'),
        }));
    });
}

test('does not evaluate arbitrary environment-style path prefixes', async () => {
    const fixture = await signingRepository();
    let passphraseRequested = false;
    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            homeDirectory: fixture.homeDirectory,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            payloadConfirmationPrompt: async () => true,
            privateKeyPathPrompt: async () => '$USER/private.pem',
            passphrasePrompt: async () => {
                passphraseRequested = true;
                return Buffer.from(signingPassphrase);
            },
        }),
        /private signing key is unavailable or inside the repository/,
    );
    assert.equal(passphraseRequested, false);
});

test('rejects an incorrect encrypted-key passphrase without publication', async () => {
    const fixture = await signingRepository();
    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            homeDirectory: fixture.homeDirectory,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            payloadConfirmationPrompt: async () => true,
            privateKeyPathPrompt: async () => '~/private.pem',
            passphrasePrompt: async () => Buffer.from('incorrect synthetic passphrase'),
        }),
        /private signing key is invalid/,
    );
    await assert.rejects(
        readFile(path.join(fixture.cwd, 'catalogue.json')),
        /ENOENT/,
    );
});

test('keeps unencrypted PKCS8 support without requesting a passphrase', async () => {
    const fixture = await signingRepository({encrypted: false});
    let passphraseRequested = false;
    await run(['sign'], {
        cwd: fixture.cwd,
        expectedFingerprint: fixture.key.fingerprint,
        homeDirectory: fixture.homeDirectory,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdin: {isTTY: true},
        stdout: ttyOutput().stream,
        payloadConfirmationPrompt: async () => true,
        privateKeyPathPrompt: async () => '~/private.pem',
        passphrasePrompt: async () => {
            passphraseRequested = true;
            return Buffer.from(signingPassphrase);
        },
    });
    assert.equal(passphraseRequested, false);
});

test('rejects an encrypted private key that does not match the trusted public key', async () => {
    const other = generateKeyPairSync('ed25519');
    const fixture = await signingRepository({signingKey: other.privateKey});
    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            homeDirectory: fixture.homeDirectory,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            payloadConfirmationPrompt: async () => true,
            privateKeyPathPrompt: async () => '~/private.pem',
            passphrasePrompt: async () => Buffer.from(signingPassphrase),
        }),
        /private key does not match the trusted public key/,
    );
});

test('rejects an oversized prepared payload before requesting a key path', async () => {
    const fixture = await repository();
    await mkdir(path.join(fixture.cwd, '.publisher'), {mode: 0o700});
    await writeFile(
        path.join(fixture.cwd, '.publisher', 'payload.json'),
        Buffer.alloc(4 * 1024 * 1024 + 1, 7),
    );
    let pathRequested = false;

    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            privateKeyPathPrompt: async () => {
                pathRequested = true;
                return '~/private.pem';
            },
        }),
        /publisher file must be a bounded regular non-symlink file/,
    );
    assert.equal(pathRequested, false);
});

test('rejects a symlinked prepared payload before requesting a key path', async () => {
    const fixture = await repository();
    await mkdir(path.join(fixture.cwd, '.publisher'), {mode: 0o700});
    const target = path.join(fixture.cwd, '.publisher', 'target.json');
    const link = path.join(fixture.cwd, '.publisher', 'payload.json');
    await writeFile(target, `${JSON.stringify(payload())}\n`);
    await symlink(target, link);
    let pathRequested = false;

    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
            privateKeyPathPrompt: async () => {
                pathRequested = true;
                return '~/private.pem';
            },
        }),
        /publisher file must be a bounded regular non-symlink file/,
    );
    assert.equal(pathRequested, false);
});

test('rejects a symlinked publisher work directory', async () => {
    const fixture = await repository();
    const target = await mkdtemp(path.join(tmpdir(), 'prism-publisher-target-'));
    await symlink(target, path.join(fixture.cwd, '.publisher'));

    await assert.rejects(
        run(['prepare'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            fetchImpl: async () => { throw new Error('network must not be reached'); },
        }),
        /publisher work directory is invalid/,
    );
});

test('rejects an insecure publisher work directory', async () => {
    const fixture = await repository();
    const workDirectory = path.join(fixture.cwd, '.publisher');
    await mkdir(workDirectory, {mode: 0o700});
    await chmod(workDirectory, 0o755);

    await assert.rejects(
        run(['sign'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            stdin: {isTTY: true},
            stdout: ttyOutput().stream,
        }),
        /publisher work directory is invalid/,
    );
});

test('rejects unknown commands', async () => {
    await assert.rejects(run(['publish-now']), /unknown command/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
