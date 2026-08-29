// $KYAULabs: cli.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createEnvelope, verifyEnvelope} from '../src/envelope.js';
import {run} from '../src/cli.js';

const integrity = `sha512-${Buffer.alloc(64, 19).toString('base64')}`;
const nextIntegrity = `sha512-${Buffer.alloc(64, 31).toString('base64')}`;
const mergeCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
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

function jsonResponse(value) {
    const body = JSON.stringify(value);
    return new Response(body, {
        status: 200,
        headers: {'content-length': String(Buffer.byteLength(body))},
    });
}

function contentResponse(pathname, value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    return jsonResponse({
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        path: pathname,
        content: bytes.toString('base64'),
    });
}

function githubEvidenceFetch(url) {
    const origin = 'https://api.github.com/repos/kyaulabs/prism';
    const responses = new Map([
        [`${origin}/releases/tags/v0.4.2`, jsonResponse({
            tag_name: 'v0.4.2',
            target_commitish: mergeCommit,
            draft: false,
            prerelease: false,
        })],
        [`${origin}/git/ref/tags/v0.4.2`, jsonResponse({
            ref: 'refs/tags/v0.4.2',
            object: {type: 'commit', sha: mergeCommit},
        })],
        [`${origin}/commits/${mergeCommit}`, jsonResponse({
            sha: mergeCommit,
            parents: [{sha: 'b'.repeat(40)}, {sha: 'c'.repeat(40)}],
        })],
        [`${origin}/contents/.prism/release.json?ref=${mergeCommit}`,
            contentResponse('.prism/release.json', {
                schemaVersion: 2,
                managedBy: '@kyaulabs/prism-core',
                versionPolicy: 'lockstep',
                packages: ['packages/prism-core', 'packages/prism-php-web'],
                adapterReleases: [{
                    package: 'packages/prism-php-web',
                    id: 'php-web',
                    displayName: 'PHP/web',
                    coreRange: '>=0.4.1 <0.5.0',
                    bootstrapProtocol: 1,
                    status: 'ACTIVE',
                }],
            })],
        [`${origin}/contents/packages/prism-php-web/package.json?ref=${mergeCommit}`,
            contentResponse('packages/prism-php-web/package.json', {
                name: '@kyaulabs/prism-php-web',
                version: '0.4.2',
                prism: {adapter: true, bootstrapProtocol: 1},
                publishConfig: {access: 'public'},
            })],
        [`${origin}/git/ref/tags/prism-php-web@0.4.2`, jsonResponse({
            ref: 'refs/tags/prism-php-web@0.4.2',
            object: {type: 'commit', sha: mergeCommit},
        })],
    ]);
    const response = responses.get(url);
    if (response === undefined) throw new Error(`unexpected GitHub request ${url}`);
    return response;
}

function npmEvidenceFetch() {
    return jsonResponse({
        versions: {
            '0.4.1': {dist: {integrity}},
            '0.4.2': {dist: {integrity: nextIntegrity}},
        },
        time: {
            '0.4.1': '2026-08-27T12:00:00.000Z',
            '0.4.2': '2026-08-28T12:00:00.000Z',
        },
    });
}

async function evidenceRepository() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-adapters-evidence-'));
    const key = keys();
    const network = {gitMutations: 0};
    await writeFile(path.join(cwd, 'adapter-catalogue-public.pem'), key.pem);
    const existing = payload();
    existing.sequence = 7;
    existing.issuedAt = '2026-08-20T00:00:00.000Z';
    existing.expiresAt = '2026-08-26T00:00:00.000Z';
    await writeFile(path.join(cwd, 'catalogue.json'), createEnvelope({
        payload: existing,
        privateKey: key.privateKey,
        publicKey: key.publicKey,
    }));
    return {
        cwd,
        key,
        mergeCommit,
        githubFetchImpl: githubEvidenceFetch,
        npmFetchImpl: npmEvidenceFetch,
        network,
        dependencies() {
            return {
                cwd,
                expectedFingerprint: key.fingerprint,
                now: new Date('2026-08-28T00:00:00.000Z'),
                stdout: output().stream,
                githubFetchImpl: githubEvidenceFetch,
                npmFetchImpl: npmEvidenceFetch,
                sleepImpl: async () => {},
            };
        },
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

test('prepare-release preserves verified records and adds exact release evidence', async () => {
    const {cwd, key} = await evidenceRepository();
    const stdout = output();
    await run(['prepare-release', '0.4.2', mergeCommit], {
        cwd,
        expectedFingerprint: key.fingerprint,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdout: stdout.stream,
        githubFetchImpl: githubEvidenceFetch,
        npmFetchImpl: npmEvidenceFetch,
        sleepImpl: async () => {},
    });

    const source = JSON.parse(await readFile(path.join(cwd, 'catalogue-source.json'), 'utf8'));
    assert.deepEqual(source.adapters[0].releases.map(({version}) => version), [
        '0.4.1',
        '0.4.2',
    ]);
    const prepared = JSON.parse(await readFile(
        path.join(cwd, '.publisher', 'payload.json'),
        'utf8',
    ));
    assert.equal(prepared.sequence, 8);
    assert.equal(prepared.adapters[0].releases[0].integrity, integrity);
    assert.equal(prepared.adapters[0].releases[1].integrity, nextIntegrity);
    assert.match(stdout.value(), /prepared release 0[.]4[.]2 catalogue sequence 8/);
    assert.match(stdout.value(), /digest [0-9a-f]{64}/);
    assert.match(stdout.value(), /expires 2026-09-03T00:00:00[.]000Z/);
});

test('prepare-renewal preserves source policy and revalidates exact npm releases', async () => {
    const {cwd, key} = await evidenceRepository();
    let npmRequests = 0;
    await run(['prepare-renewal'], {
        cwd,
        expectedFingerprint: key.fingerprint,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdout: output().stream,
        githubFetchImpl: async () => {
            throw new Error('renewal must not request GitHub release evidence');
        },
        npmFetchImpl: async () => {
            npmRequests += 1;
            return npmEvidenceFetch();
        },
        sleepImpl: async () => {},
    });

    const source = JSON.parse(await readFile(path.join(cwd, 'catalogue-source.json'), 'utf8'));
    assert.deepEqual(source.adapters[0].releases, [{
        version: '0.4.1',
        coreRange: '>=0.4.1 <0.5.0',
        bootstrapProtocol: 1,
        status: 'ACTIVE',
    }]);
    const prepared = JSON.parse(await readFile(
        path.join(cwd, '.publisher', 'payload.json'),
        'utf8',
    ));
    assert.equal(prepared.sequence, 8);
    assert.equal(prepared.adapters[0].releases[0].integrity, integrity);
    assert.equal(npmRequests, 1);
});

test('evidence failures create no source or prepared payload', async () => {
    const failures = [{
        githubFetchImpl: async () => {
            throw new Error('GitHub unavailable');
        },
        npmFetchImpl: npmEvidenceFetch,
    }, {
        githubFetchImpl: githubEvidenceFetch,
        npmFetchImpl: async () => {
            throw new Error('npm unavailable');
        },
    }];
    for (const failure of failures) {
        const {cwd, key} = await evidenceRepository();
        await assert.rejects(run(['prepare-release', '0.4.2', mergeCommit], {
            cwd,
            expectedFingerprint: key.fingerprint,
            now: new Date('2026-08-28T00:00:00.000Z'),
            stdout: output().stream,
            ...failure,
            sleepImpl: async () => {},
        }));
        await assert.rejects(readFile(path.join(cwd, 'catalogue-source.json')), /ENOENT/);
        await assert.rejects(readFile(path.join(cwd, '.publisher', 'payload.json')), /ENOENT/);
    }
});

test('rejects malformed preparation arguments before network access', async () => {
    const {cwd, key} = await evidenceRepository();
    const cases = [
        ['prepare-release'],
        ['prepare-release', '0.4.2'],
        ['prepare-release', '0.4.2', mergeCommit, 'extra'],
        ['prepare-release', '0.4.2-rc.1', mergeCommit],
        ['prepare-release', '0.4.2', 'main'],
        ['prepare-renewal', 'extra'],
    ];
    for (const args of cases) {
        let fetched = false;
        await assert.rejects(run(args, {
            cwd,
            expectedFingerprint: key.fingerprint,
            githubFetchImpl: async () => {
                fetched = true;
                throw new Error('must not fetch');
            },
            npmFetchImpl: async () => {
                fetched = true;
                throw new Error('must not fetch');
            },
        }));
        assert.equal(fetched, false);
    }
});

test('rejects manual local-source preparation as catalogue authority', async () => {
    const {cwd, key} = await repository();
    await assert.rejects(run(['prepare'], {
        cwd,
        expectedFingerprint: key.fingerprint,
    }), /unknown command/);
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
    const fixture = await evidenceRepository();
    const target = await mkdtemp(path.join(tmpdir(), 'prism-publisher-target-'));
    await symlink(target, path.join(fixture.cwd, '.publisher'));

    await assert.rejects(
        run(['prepare-renewal'], {
            cwd: fixture.cwd,
            expectedFingerprint: fixture.key.fingerprint,
            now: new Date('2026-08-28T00:00:00.000Z'),
            npmFetchImpl: npmEvidenceFetch,
            sleepImpl: async () => {},
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
