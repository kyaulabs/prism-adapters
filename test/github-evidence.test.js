// $KYAULabs: github-evidence.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {resolvePrismReleaseEvidence} from '../src/github-evidence.js';

const origin = 'https://api.github.com/repos/kyaulabs/prism';
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
    prism: {
        adapter: true,
        bootstrapProtocol: 1,
        toolchain: './toolchain.json',
        handler: './scripts/prism-tool-adapter.js',
    },
    publishConfig: {access: 'public'},
};

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

function githubFixture() {
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
    const calls = [];
    return {
        calls,
        responses,
        fetchImpl: async (url) => {
            calls.push(url);
            const response = responses.get(url);
            if (response === undefined) throw new Error(`unexpected request ${url}`);
            return response;
        },
    };
}

test('rejects malformed trigger hints before GitHub access', async () => {
    const cases = [
        {version: '0.4.2-rc.1', mergeCommit},
        {version: '04.2.0', mergeCommit},
        {version: '0.4.2', mergeCommit: 'main'},
        {version: '0.4.2', mergeCommit: mergeCommit.toUpperCase()},
    ];
    for (const candidate of cases) {
        let fetched = false;
        await assert.rejects(resolvePrismReleaseEvidence({
            ...candidate,
            fetchImpl: async () => {
                fetched = true;
                throw new Error('must not fetch');
            },
        }), /Prism release evidence is invalid/);
        assert.equal(fetched, false);
    }
});

test('rejects draft, prerelease, and mismatched Releases', async () => {
    const releases = [{
        tag_name: 'v0.4.2', target_commitish: mergeCommit, draft: true, prerelease: false,
    }, {
        tag_name: 'v0.4.2', target_commitish: mergeCommit, draft: false, prerelease: true,
    }, {
        tag_name: 'v0.4.1', target_commitish: mergeCommit, draft: false, prerelease: false,
    }, {
        tag_name: 'v0.4.2', target_commitish: 'd'.repeat(40), draft: false, prerelease: false,
    }];
    for (const release of releases) {
        const github = githubFixture();
        github.responses.set(`${origin}/releases/tags/v0.4.2`, jsonResponse(release));
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
        assert.equal(github.calls.length, 1);
    }
});

test('rejects mutable tag indirection and non-matching merge commits', async () => {
    const cases = [{
        url: `${origin}/git/ref/tags/v0.4.2`,
        value: {ref: 'refs/tags/v0.4.2', object: {type: 'tag', sha: mergeCommit}},
    }, {
        url: `${origin}/git/ref/tags/v0.4.2`,
        value: {ref: 'refs/tags/v0.4.2', object: {type: 'commit', sha: 'd'.repeat(40)}},
    }, {
        url: `${origin}/commits/${mergeCommit}`,
        value: {sha: 'd'.repeat(40), parents: [{sha: 'b'.repeat(40)}, {sha: 'c'.repeat(40)}]},
    }, {
        url: `${origin}/commits/${mergeCommit}`,
        value: {sha: mergeCommit, parents: [{sha: 'b'.repeat(40)}]},
    }];
    for (const candidate of cases) {
        const github = githubFixture();
        github.responses.set(candidate.url, jsonResponse(candidate.value));
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('rejects open, malformed, and escaping release declarations', async () => {
    const cases = [
        {...releaseConfiguration, registry: 'https://example.test'},
        {...releaseConfiguration, schemaVersion: 1},
        {...releaseConfiguration, managedBy: 'other'},
        {...releaseConfiguration, versionPolicy: 'independent'},
        {...releaseConfiguration, packages: ['packages/prism-php-web', 'packages/prism-php-web']},
        {...releaseConfiguration, packages: ['../packages/prism-php-web']},
        {...releaseConfiguration, adapterReleases: []},
        {...releaseConfiguration, adapterReleases: [{
            ...releaseConfiguration.adapterReleases[0],
            packageName: '@kyaulabs/prism-php-web',
        }]},
        {...releaseConfiguration, adapterReleases: [{
            ...releaseConfiguration.adapterReleases[0],
            package: 'packages/missing',
        }]},
    ];
    for (const configuration of cases) {
        const github = githubFixture();
        github.responses.set(
            `${origin}/contents/.prism/release.json?ref=${mergeCommit}`,
            contentResponse('.prism/release.json', configuration),
        );
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('rejects malformed and oversized GitHub content evidence', async () => {
    const url = `${origin}/contents/.prism/release.json?ref=${mergeCommit}`;
    const valid = contentResponse('.prism/release.json', releaseConfiguration);
    const validValue = await valid.json();
    const cases = [
        {...validValue, type: 'symlink'},
        {...validValue, encoding: 'utf-8'},
        {...validValue, path: 'other.json'},
        {...validValue, size: 65_537},
        {...validValue, size: validValue.size + 1},
        {...validValue, content: 'AAAA'},
        {...validValue, content: `${validValue.content}\r`},
    ];
    for (const value of cases) {
        const github = githubFixture();
        github.responses.set(url, jsonResponse(value));
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('rejects private, mismatched, and non-adapter package manifests', async () => {
    const cases = [
        {...packageManifest, private: true},
        {...packageManifest, publishConfig: {access: 'restricted'}},
        {...packageManifest, name: '@other/prism-php-web'},
        {...packageManifest, version: '0.4.1'},
        {...packageManifest, prism: {...packageManifest.prism, adapter: false}},
        {...packageManifest, prism: {...packageManifest.prism, bootstrapProtocol: 2}},
    ];
    for (const manifest of cases) {
        const github = githubFixture();
        github.responses.set(
            `${origin}/contents/packages/prism-php-web/package.json?ref=${mergeCommit}`,
            contentResponse('packages/prism-php-web/package.json', manifest),
        );
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('rejects malformed package names before deriving a package tag request', async () => {
    const github = githubFixture();
    github.responses.set(
        `${origin}/contents/packages/prism-php-web/package.json?ref=${mergeCommit}`,
        contentResponse('packages/prism-php-web/package.json', {
            ...packageManifest,
            name: '@kyaulabs/prism-php-web?ref=main',
        }),
    );

    await assert.rejects(resolvePrismReleaseEvidence({
        version: '0.4.2',
        mergeCommit,
        fetchImpl: github.fetchImpl,
    }), /Prism release evidence is invalid/);
    assert.equal(github.calls.length, 5);
});

test('rejects mutable and mismatched package tags', async () => {
    const url = `${origin}/git/ref/tags/prism-php-web@0.4.2`;
    const refs = [{
        ref: 'refs/tags/prism-php-web@0.4.2',
        object: {type: 'tag', sha: mergeCommit},
    }, {
        ref: 'refs/tags/prism-php-web@0.4.1',
        object: {type: 'commit', sha: mergeCommit},
    }, {
        ref: 'refs/tags/prism-php-web@0.4.2',
        object: {type: 'commit', sha: 'd'.repeat(40)},
    }];
    for (const ref of refs) {
        const github = githubFixture();
        github.responses.set(url, jsonResponse(ref));
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('rejects malformed declaration identity and compatibility claims', async () => {
    const declaration = releaseConfiguration.adapterReleases[0];
    const cases = [
        {...declaration, id: 'PHP-Web'},
        {...declaration, displayName: 'PHP\nweb'},
        {...declaration, coreRange: 'latest'},
        {...declaration, coreRange: '>=1.0.0 <1.0.0'},
        {...declaration, bootstrapProtocol: 0},
        {...declaration, status: 'UNKNOWN'},
    ];
    for (const candidate of cases) {
        const github = githubFixture();
        github.responses.set(
            `${origin}/contents/.prism/release.json?ref=${mergeCommit}`,
            contentResponse('.prism/release.json', {
                ...releaseConfiguration,
                adapterReleases: [candidate],
            }),
        );
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
});

test('fails closed on redirected, oversized, and unavailable GitHub responses', async () => {
    const url = `${origin}/releases/tags/v0.4.2`;
    const responses = [
        new Response('', {status: 302, headers: {location: 'https://other.test/'}}),
        new Response('{}', {
            status: 200,
            headers: {'content-length': String(4 * 1024 * 1024 + 1)},
        }),
    ];
    for (const response of responses) {
        const github = githubFixture();
        github.responses.set(url, response);
        await assert.rejects(resolvePrismReleaseEvidence({
            version: '0.4.2',
            mergeCommit,
            fetchImpl: github.fetchImpl,
        }), /Prism release evidence is invalid/);
    }
    await assert.rejects(resolvePrismReleaseEvidence({
        version: '0.4.2',
        mergeCommit,
        fetchImpl: async () => {
            throw new Error('network unavailable');
        },
    }), /Prism release evidence is unavailable/);
});

test('rejects duplicate declarations before package evidence requests', async () => {
    const github = githubFixture();
    github.responses.set(
        `${origin}/contents/.prism/release.json?ref=${mergeCommit}`,
        contentResponse('.prism/release.json', {
            ...releaseConfiguration,
            adapterReleases: [
                releaseConfiguration.adapterReleases[0],
                releaseConfiguration.adapterReleases[0],
            ],
        }),
    );

    await assert.rejects(resolvePrismReleaseEvidence({
        version: '0.4.2',
        mergeCommit,
        fetchImpl: github.fetchImpl,
    }), /Prism release evidence is invalid/);
    assert.equal(github.calls.length, 4);
});

test('resolves closed catalogue source from agreeing immutable Prism evidence', async () => {
    const github = githubFixture();
    const evidence = await resolvePrismReleaseEvidence({
        version: '0.4.2',
        mergeCommit,
        fetchImpl: github.fetchImpl,
    });

    assert.deepEqual(evidence, {
        repository: 'kyaulabs/prism',
        version: '0.4.2',
        mergeCommit,
        adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.2',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }],
    });
    assert.equal(github.calls.length, 6);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
