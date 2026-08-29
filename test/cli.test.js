// $KYAULabs: cli.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createEnvelope} from '../src/envelope.js';
import {run} from '../src/cli.js';

const integrity = `sha512-${Buffer.alloc(64, 19).toString('base64')}`;
const nextIntegrity = `sha512-${Buffer.alloc(64, 31).toString('base64')}`;
const mergeCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const releaseConfiguration = {
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
};
const packageManifest = {
    name: '@kyaulabs/prism-php-web',
    version: '0.4.2',
    prism: {adapter: true, bootstrapProtocol: 1},
    publishConfig: {access: 'public'},
};

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

async function readOptional(filePath) {
    try {
        return await readFile(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
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
            contentResponse('.prism/release.json', releaseConfiguration)],
        [`${origin}/contents/packages/prism-php-web/package.json?ref=${mergeCommit}`,
            contentResponse('packages/prism-php-web/package.json', packageManifest)],
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
            '0.4.0': {dist: {integrity}},
            '0.4.1': {dist: {integrity}},
            '0.4.2': {dist: {integrity: nextIntegrity}},
        },
        time: {
            '0.4.0': '2026-08-20T12:00:00.000Z',
            '0.4.1': '2026-08-27T12:00:00.000Z',
            '0.4.2': '2026-08-28T12:00:00.000Z',
        },
    });
}

function githubEvidenceFetchWithFault(fault) {
    const origin = 'https://api.github.com/repos/kyaulabs/prism';
    return async (url) => {
        if (fault === 'release-redirect' && url.endsWith('/releases/tags/v0.4.2')) {
            return new Response('', {status: 302, headers: {location: 'https://other.test/'}});
        }
        if (fault === 'streamed-oversized-release' && url.endsWith('/releases/tags/v0.4.2')) {
            return new Response(Buffer.alloc(4 * 1024 * 1024 + 1, 7), {status: 200});
        }
        if (fault === 'github-timeout-exhaustion') throw new Error('GitHub timeout');
        if (fault === 'mutable-release-ref' && url.endsWith('/git/ref/tags/v0.4.2')) {
            return jsonResponse({
                ref: 'refs/tags/v0.4.2',
                object: {type: 'tag', sha: mergeCommit},
            });
        }
        if (fault === 'prerelease' && url.endsWith('/releases/tags/v0.4.2')) {
            return jsonResponse({
                tag_name: 'v0.4.2',
                target_commitish: mergeCommit,
                draft: false,
                prerelease: true,
            });
        }
        if (fault === 'release-commit-disagreement' &&
            url.endsWith('/releases/tags/v0.4.2')) {
            return jsonResponse({
                tag_name: 'v0.4.2',
                target_commitish: 'd'.repeat(40),
                draft: false,
                prerelease: false,
            });
        }
        if (fault === 'package-tag-disagreement' &&
            url.endsWith('/git/ref/tags/prism-php-web@0.4.2')) {
            return jsonResponse({
                ref: 'refs/tags/prism-php-web@0.4.2',
                object: {type: 'commit', sha: 'd'.repeat(40)},
            });
        }
        if (fault === 'manifest-version-disagreement' &&
            url.includes('/contents/packages/prism-php-web/package.json')) {
            return contentResponse('packages/prism-php-web/package.json', {
                ...packageManifest,
                version: '0.4.1',
            });
        }
        if (url.includes('/contents/.prism/release.json') &&
            ['declaration-unknown-field', 'protocol-mismatch',
                'verified-catalogue-identity-conflict'].includes(fault)) {
            const declaration = structuredClone(releaseConfiguration.adapterReleases[0]);
            if (fault === 'declaration-unknown-field') declaration.registry = 'https://example.test';
            if (fault === 'protocol-mismatch') declaration.bootstrapProtocol = 2;
            if (fault === 'verified-catalogue-identity-conflict') {
                declaration.displayName = 'Changed PHP/web';
            }
            return contentResponse('.prism/release.json', {
                ...releaseConfiguration,
                adapterReleases: [declaration],
            });
        }
        return githubEvidenceFetch(url);
    };
}

function npmEvidenceFetchWithFault(fault) {
    return async () => {
        if (fault === 'missing-npm-integrity') {
            return jsonResponse({
                versions: {'0.4.1': {dist: {}}},
                time: {'0.4.1': '2026-08-27T12:00:00.000Z'},
            });
        }
        if (fault === 'noncanonical-npm-integrity') {
            return jsonResponse({
                versions: {'0.4.1': {dist: {integrity: 'sha512-AAAA'}}},
                time: {'0.4.1': '2026-08-27T12:00:00.000Z'},
            });
        }
        if (fault === 'invalid-npm-publication-time') {
            return jsonResponse({
                versions: {'0.4.1': {dist: {integrity}}},
                time: {'0.4.1': 'not-a-time'},
            });
        }
        return npmEvidenceFetch();
    };
}

async function evidenceRepository({existingCatalogue = null} = {}) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-adapters-evidence-'));
    const key = keys();
    const network = {gitMutations: 0};
    await writeFile(path.join(cwd, 'adapter-catalogue-public.pem'), key.pem);
    const existing = existingCatalogue ?? payload();
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
        dependencies({githubFault = null, npmFault = null} = {}) {
            return {
                cwd,
                expectedFingerprint: key.fingerprint,
                now: new Date('2026-08-28T00:00:00.000Z'),
                stdout: output().stream,
                githubFetchImpl: githubFault === null
                    ? githubEvidenceFetch
                    : githubEvidenceFetchWithFault(githubFault),
                npmFetchImpl: npmFault === null
                    ? npmEvidenceFetch
                    : npmEvidenceFetchWithFault(npmFault),
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

test('prepare-renewal preserves unrelated releases and statuses byte-for-byte', async () => {
    const existing = payload();
    existing.adapters[0].releases.unshift({
        version: '0.4.0',
        coreRange: '>=0.4.0 <0.5.0',
        bootstrapProtocol: 1,
        integrity,
        publishedAt: '2026-08-20T12:00:00.000Z',
        status: 'REVOKED',
    });
    const fixture = await evidenceRepository({existingCatalogue: existing});
    await run(['prepare-renewal'], fixture.dependencies());

    const expected = {
        schemaVersion: 1,
        adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.0',
                coreRange: '>=0.4.0 <0.5.0',
                bootstrapProtocol: 1,
                status: 'REVOKED',
            }, {
                version: '0.4.1',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }],
    };
    assert.equal(
        await readFile(path.join(fixture.cwd, 'catalogue-source.json'), 'utf8'),
        `${JSON.stringify(expected, null, 2)}\n`,
    );
});

test('prepare-release fails closed on a redirected Release response', async () => {
    const fixture = await evidenceRepository();
    await assert.rejects(
        run(
            ['prepare-release', '0.4.2', fixture.mergeCommit],
            fixture.dependencies({githubFault: 'release-redirect'}),
        ),
        /Prism release evidence is invalid/,
    );
    assert.equal(await readOptional(path.join(fixture.cwd, 'catalogue-source.json')), null);
    assert.equal(await readOptional(path.join(fixture.cwd, '.publisher', 'payload.json')), null);
    assert.equal(fixture.network.gitMutations, 0);
});

test('prepare-release fails closed across the fake evidence matrix', async () => {
    const faults = [
        {githubFault: 'streamed-oversized-release'},
        {githubFault: 'github-timeout-exhaustion'},
        {githubFault: 'mutable-release-ref'},
        {githubFault: 'prerelease'},
        {githubFault: 'release-commit-disagreement'},
        {githubFault: 'package-tag-disagreement'},
        {githubFault: 'manifest-version-disagreement'},
        {githubFault: 'declaration-unknown-field'},
        {githubFault: 'protocol-mismatch'},
        {npmFault: 'missing-npm-integrity'},
        {npmFault: 'noncanonical-npm-integrity'},
        {npmFault: 'invalid-npm-publication-time'},
        {githubFault: 'verified-catalogue-identity-conflict'},
    ];
    for (const fault of faults) {
        const fixture = await evidenceRepository();
        await assert.rejects(run(
            ['prepare-release', '0.4.2', fixture.mergeCommit],
            fixture.dependencies(fault),
        ));
        assert.equal(await readOptional(path.join(fixture.cwd, 'catalogue-source.json')), null);
        assert.equal(await readOptional(path.join(fixture.cwd, '.publisher', 'payload.json')), null);
        assert.equal(fixture.network.gitMutations, 0);
    }
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

test('rejects local production signing', async () => {
    const {cwd, key} = await repository();

    await assert.rejects(
        run(['sign'], {cwd, expectedFingerprint: key.fingerprint}),
        /unknown command/,
    );
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

test('rejects unknown commands', async () => {
    await assert.rejects(run(['publish-now']), /unknown command/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
