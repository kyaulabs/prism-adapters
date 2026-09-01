// $KYAULabs: github-publication.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {publishCatalogueCandidate} from '../src/github-publication.js';

function response(value, {status = 200, headers = {}} = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {'content-type': 'application/json', ...headers},
    });
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

const CREDENTIAL = 'opaque-synthetic-publication-credential';
const SIGNED_COMMIT = Object.freeze({
    author: Object.freeze({
        name: 'kyaulabs-bot',
        email: 'actions@kyaulabs.com',
        date: '2026-08-31T12:34:56.000Z',
    }),
    committer: Object.freeze({
        name: 'kyaulabs-bot',
        email: 'actions@kyaulabs.com',
        date: '2026-08-31T12:34:56.000Z',
    }),
    payload: 'synthetic canonical commit payload',
    signature: '-----BEGIN PGP SIGNATURE-----\nsynthetic\n-----END PGP SIGNATURE-----\n',
});

function assertCredentialBoundary(requests) {
    for (const {url, options} of requests) {
        assert.match(url, /^https:\/\/api[.]github[.]com\/repos\/kyaulabs\/prism-adapters\//);
        assert.equal(options.headers.authorization, `Bearer ${CREDENTIAL}`);
        if (options.body !== undefined) assert.doesNotMatch(options.body, new RegExp(CREDENTIAL));
    }
}

test('fails closed when the open pull-request snapshot is paginated', async () => {
    const baseSha = 'a'.repeat(40);
    const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
    const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
    const intent = {
        baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(sourceBytes),
        envelopeDigest: sha256(envelopeBytes),
    };
    const pulls = Array.from({length: 100}, (_value, index) => ({
        number: index + 1,
        state: 'open',
        head: {ref: `feature-${index}`, sha: 'd'.repeat(40)},
        base: {ref: 'main', sha: baseSha},
    }));
    let requests = 0;
    const fetchImpl = async (url) => {
        requests += 1;
        return url.endsWith('/git/ref/heads/main')
            ? response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}})
            : response(pulls, {
            headers: {
                link: '<https://api.github.com/repositories/7/pulls?page=2>; rel="next"',
            },
        });
    };

    await assert.rejects(publishCatalogueCandidate({
        token: CREDENTIAL,
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
    }), /GitHub publication state is invalid/);
    assert.equal(requests, 2);
});

test('reports exact existing branch and pull request as idempotent success', async () => {
    const baseSha = 'a'.repeat(40);
    const commitSha = 'd'.repeat(40);
    const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
    const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
    const intent = {
        baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(sourceBytes),
        envelopeDigest: sha256(envelopeBytes),
    };
    const requests = [];
    let signerCalled = false;
    const fetchImpl = async (url, options) => {
        requests.push({url, options});
        if (url.endsWith('/git/ref/heads/main')) {
            return response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}});
        }
        if (url.includes('/pulls?')) {
            return response([{
                number: 17,
                state: 'open',
                head: {ref: intent.branchName, sha: commitSha},
                base: {ref: 'main', sha: baseSha},
            }]);
        }
        if (url.includes('/git/ref/heads/catalogue%2Fsequence-8')) {
            return response({
                ref: 'refs/heads/catalogue/sequence-8',
                object: {type: 'commit', sha: commitSha},
            });
        }
        if (url.includes('/compare/')) {
            return response({
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                merge_base_commit: {sha: baseSha},
                commits: [{sha: commitSha, parents: [{sha: baseSha}]}],
                files: [
                    {filename: 'catalogue-source.json', status: 'modified'},
                    {filename: 'catalogue.json', status: 'modified'},
                ],
            });
        }
        if (url.includes('/contents/catalogue-source.json')) {
            return response({
                type: 'file',
                path: 'catalogue-source.json',
                encoding: 'base64',
                size: sourceBytes.length,
                content: sourceBytes.toString('base64'),
            });
        }
        if (url.includes('/contents/catalogue.json')) {
            return response({
                type: 'file',
                path: 'catalogue.json',
                encoding: 'base64',
                size: envelopeBytes.length,
                content: envelopeBytes.toString('base64'),
            });
        }
        throw new Error(`unexpected synthetic URL ${url}`);
    };

    const result = await publishCatalogueCandidate({
        token: CREDENTIAL,
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
        signCommitImpl: async () => {
            signerCalled = true;
            return SIGNED_COMMIT;
        },
    });

    assert.deepEqual(result, {
        state: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: 17,
    });
    assert.equal(requests.some(({options}) => options.method === 'POST'), false);
    assert.equal(signerCalled, false);
    assertCredentialBoundary(requests);
});

test('creates one commit, atomic sequence ref, and human-merged pull request', async () => {
    const baseSha = 'a'.repeat(40);
    const commitSha = 'd'.repeat(40);
    const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
    const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
    const intent = {
        baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(sourceBytes),
        envelopeDigest: sha256(envelopeBytes),
    };
    const requests = [];
    let branchCreated = false;
    let pullCreated = false;
    let blob = 0;
    const fetchImpl = async (url, options) => {
        requests.push({url, options});
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/git/ref/heads/main')) {
            return response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}});
        }
        if (pathname.endsWith('/pulls') && options.method === 'GET') {
            return response(pullCreated ? [{
                number: 17,
                state: 'open',
                head: {ref: intent.branchName, sha: commitSha},
                base: {ref: 'main', sha: baseSha},
            }] : []);
        }
        if (pathname.includes('/git/ref/heads/catalogue%2Fsequence-8')) {
            return branchCreated
                ? response({
                    ref: 'refs/heads/catalogue/sequence-8',
                    object: {type: 'commit', sha: commitSha},
                })
                : new Response(null, {status: 404});
        }
        if (pathname.endsWith(`/git/commits/${baseSha}`)) {
            return response({sha: baseSha, tree: {sha: '1'.repeat(40)}});
        }
        if (pathname.endsWith('/git/blobs')) {
            blob += 1;
            return response({sha: String(blob + 1).repeat(40)}, {status: 201});
        }
        if (pathname.endsWith('/git/trees')) {
            return response({sha: '4'.repeat(40)}, {status: 201});
        }
        if (pathname.endsWith('/git/commits') && options.method === 'POST') {
            const request = JSON.parse(options.body);
            return response({
                sha: commitSha,
                verification: {
                    verified: true,
                    reason: 'valid',
                    signature: request.signature,
                    payload: SIGNED_COMMIT.payload,
                },
            }, {status: 201});
        }
        if (pathname.endsWith('/git/refs')) {
            branchCreated = true;
            return response({
                ref: 'refs/heads/catalogue/sequence-8',
                object: {type: 'commit', sha: commitSha},
            }, {status: 201});
        }
        if (pathname.includes('/compare/')) {
            return response({
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                merge_base_commit: {sha: baseSha},
                commits: [{sha: commitSha, parents: [{sha: baseSha}]}],
                files: [
                    {filename: 'catalogue-source.json', status: 'modified'},
                    {filename: 'catalogue.json', status: 'modified'},
                ],
            });
        }
        if (pathname.includes('/contents/catalogue-source.json')) {
            return response({
                type: 'file', path: 'catalogue-source.json', encoding: 'base64',
                size: sourceBytes.length, content: sourceBytes.toString('base64'),
            });
        }
        if (pathname.includes('/contents/catalogue.json')) {
            return response({
                type: 'file', path: 'catalogue.json', encoding: 'base64',
                size: envelopeBytes.length, content: envelopeBytes.toString('base64'),
            });
        }
        if (pathname.endsWith('/pulls') && options.method === 'POST') {
            pullCreated = true;
            return response({number: 17}, {status: 201});
        }
        throw new Error(`unexpected synthetic request ${options.method} ${url}`);
    };

    const result = await publishCatalogueCandidate({
        token: CREDENTIAL,
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
        now: new Date('2026-08-31T12:34:56.789Z'),
        commitSigning: {synthetic: true},
        signCommitImpl: async (input) => {
            assert.equal(input.treeSha, '4'.repeat(40));
            assert.equal(input.parentSha, baseSha);
            assert.equal(input.message, 'chore(catalogue): publish sequence 8');
            assert.equal(input.synthetic, true);
            return SIGNED_COMMIT;
        },
    });

    assert.deepEqual(result, {
        state: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: 17,
    });
    const posts = requests.filter(({options}) => options.method === 'POST');
    assert.deepEqual(posts.map(({url}) => new URL(url).pathname), [
        '/repos/kyaulabs/prism-adapters/git/blobs',
        '/repos/kyaulabs/prism-adapters/git/blobs',
        '/repos/kyaulabs/prism-adapters/git/trees',
        '/repos/kyaulabs/prism-adapters/git/commits',
        '/repos/kyaulabs/prism-adapters/git/refs',
        '/repos/kyaulabs/prism-adapters/pulls',
    ]);
    assert.deepEqual(JSON.parse(posts[3].options.body), {
        message: 'chore(catalogue): publish sequence 8',
        tree: '4'.repeat(40),
        parents: [baseSha],
        author: SIGNED_COMMIT.author,
        committer: SIGNED_COMMIT.committer,
        signature: SIGNED_COMMIT.signature,
    });
    assert.deepEqual(JSON.parse(posts[4].options.body), {
        ref: 'refs/heads/catalogue/sequence-8',
        sha: commitSha,
    });
    assert.deepEqual(JSON.parse(posts[5].options.body), {
        title: 'chore(catalogue): publish sequence 8',
        head: 'catalogue/sequence-8',
        base: 'main',
        body: 'Synthetic publication body',
        maintainer_can_modify: false,
        draft: false,
    });
    assertCredentialBoundary(requests);
});

test('recovers exact ref and pull-request creation races without overwriting', async () => {
    const baseSha = 'a'.repeat(40);
    const commitSha = 'd'.repeat(40);
    const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
    const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
    const intent = {
        baseSha,
        sequence: 8,
        branchName: 'catalogue/sequence-8',
        sourceDigest: sha256(sourceBytes),
        envelopeDigest: sha256(envelopeBytes),
    };
    let branchCreated = false;
    let pullCreated = false;
    let blob = 0;
    const fetchImpl = async (url, options) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/git/ref/heads/main')) {
            return response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}});
        }
        if (pathname.endsWith('/pulls') && options.method === 'GET') {
            return response(pullCreated ? [{
                number: 17,
                state: 'open',
                head: {ref: intent.branchName, sha: commitSha},
                base: {ref: 'main', sha: baseSha},
            }] : []);
        }
        if (pathname.includes('/git/ref/heads/catalogue%2Fsequence-8')) {
            return branchCreated
                ? response({
                    ref: 'refs/heads/catalogue/sequence-8',
                    object: {type: 'commit', sha: commitSha},
                })
                : new Response(null, {status: 404});
        }
        if (pathname.endsWith(`/git/commits/${baseSha}`)) {
            return response({sha: baseSha, tree: {sha: '1'.repeat(40)}});
        }
        if (pathname.endsWith('/git/blobs')) {
            blob += 1;
            return response({sha: String(blob + 1).repeat(40)}, {status: 201});
        }
        if (pathname.endsWith('/git/trees')) return response({sha: '4'.repeat(40)}, {status: 201});
        if (pathname.endsWith('/git/commits') && options.method === 'POST') {
            const request = JSON.parse(options.body);
            return response({
                sha: commitSha,
                verification: {
                    verified: true,
                    reason: 'valid',
                    signature: request.signature,
                    payload: SIGNED_COMMIT.payload,
                },
            }, {status: 201});
        }
        if (pathname.endsWith('/git/refs')) {
            branchCreated = true;
            return new Response(null, {status: 422});
        }
        if (pathname.includes('/compare/')) {
            return response({
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
                merge_base_commit: {sha: baseSha},
                commits: [{sha: commitSha, parents: [{sha: baseSha}]}],
                files: [
                    {filename: 'catalogue-source.json', status: 'modified'},
                    {filename: 'catalogue.json', status: 'modified'},
                ],
            });
        }
        if (pathname.includes('/contents/catalogue-source.json')) {
            return response({
                type: 'file', path: 'catalogue-source.json', encoding: 'base64',
                size: sourceBytes.length, content: sourceBytes.toString('base64'),
            });
        }
        if (pathname.includes('/contents/catalogue.json')) {
            return response({
                type: 'file', path: 'catalogue.json', encoding: 'base64',
                size: envelopeBytes.length, content: envelopeBytes.toString('base64'),
            });
        }
        if (pathname.endsWith('/pulls') && options.method === 'POST') {
            pullCreated = true;
            return new Response(null, {status: 422});
        }
        throw new Error(`unexpected synthetic request ${options.method} ${url}`);
    };

    assert.deepEqual(await publishCatalogueCandidate({
        token: CREDENTIAL,
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
        now: new Date('2026-08-31T12:34:56.789Z'),
        commitSigning: {synthetic: true},
        signCommitImpl: async () => SIGNED_COMMIT,
    }), {
        state: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: 17,
    });
});

test('creates no ref or pull request for invalid GitHub commit verification', async () => {
    const reasons = [
        undefined,
        'unsigned',
        'unknown_key',
        'bad_email',
        'unverified_email',
        'malformed_signature',
        'invalid',
        'gpgverify_error',
        'gpgverify_unavailable',
    ];
    const cases = [
        ...reasons.map((reason) => reason === undefined
            ? {verification: undefined}
            : {verification: {verified: false, reason,
                signature: SIGNED_COMMIT.signature, payload: SIGNED_COMMIT.payload}}),
        {verification: {verified: true, reason: 'valid',
            signature: 'different', payload: SIGNED_COMMIT.payload}},
        {verification: {verified: true, reason: 'valid',
            signature: SIGNED_COMMIT.signature, payload: 'different'}},
        {verification: {verified: true, reason: 'valid',
            signature: SIGNED_COMMIT.signature, payload: SIGNED_COMMIT.payload}, sha: 'bad'},
    ];
    for (const [index, value] of cases.entries()) {
        const baseSha = 'a'.repeat(40);
        const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
        const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
        const requests = [];
        let blob = 0;
        const fetchImpl = async (url, options) => {
            requests.push({url, options});
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/git/ref/heads/main')) {
                return response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}});
            }
            if (pathname.endsWith('/pulls') && options.method === 'GET') return response([]);
            if (pathname.includes('/git/ref/heads/catalogue%2Fsequence-8')) {
                return new Response(null, {status: 404});
            }
            if (pathname.endsWith(`/git/commits/${baseSha}`)) {
                return response({sha: baseSha, tree: {sha: '1'.repeat(40)}});
            }
            if (pathname.endsWith('/git/blobs')) {
                blob += 1;
                return response({sha: String(blob + 1).repeat(40)}, {status: 201});
            }
            if (pathname.endsWith('/git/trees')) {
                return response({sha: '4'.repeat(40)}, {status: 201});
            }
            if (pathname.endsWith('/git/commits') && options.method === 'POST') {
                return response({
                    sha: value.sha ?? 'd'.repeat(40),
                    ...(value.verification === undefined
                        ? {}
                        : {verification: value.verification}),
                }, {status: 201});
            }
            throw new Error(`unexpected request in verification case ${index}: ${url}`);
        };
        await assert.rejects(publishCatalogueCandidate({
            token: CREDENTIAL,
            intent: {
                baseSha,
                sequence: 8,
                branchName: 'catalogue/sequence-8',
                sourceDigest: sha256(sourceBytes),
                envelopeDigest: sha256(envelopeBytes),
            },
            sourceBytes,
            envelopeBytes,
            title: 'chore(catalogue): publish sequence 8',
            body: 'Synthetic publication body',
            fetchImpl,
            now: new Date('2026-08-31T12:34:56.789Z'),
            signCommitImpl: async () => SIGNED_COMMIT,
        }), /GitHub publication state is invalid/);
        const writes = requests.filter(({options}) => options.method === 'POST')
            .map(({url}) => new URL(url).pathname);
        assert.equal(writes.includes('/repos/kyaulabs/prism-adapters/git/refs'), false);
        assert.equal(writes.includes('/repos/kyaulabs/prism-adapters/pulls'), false);
    }
});

test('creates no commit, ref, or pull request when commit signing fails', async () => {
    const baseSha = 'a'.repeat(40);
    const sourceBytes = Buffer.from('{"schemaVersion":1,"adapters":[]}\n');
    const envelopeBytes = Buffer.from('{"synthetic":"signed-envelope"}\n');
    const requests = [];
    let blob = 0;
    const fetchImpl = async (url, options) => {
        requests.push({url, options});
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/git/ref/heads/main')) {
            return response({ref: 'refs/heads/main', object: {type: 'commit', sha: baseSha}});
        }
        if (pathname.endsWith('/pulls') && options.method === 'GET') return response([]);
        if (pathname.includes('/git/ref/heads/catalogue%2Fsequence-8')) {
            return new Response(null, {status: 404});
        }
        if (pathname.endsWith(`/git/commits/${baseSha}`)) {
            return response({sha: baseSha, tree: {sha: '1'.repeat(40)}});
        }
        if (pathname.endsWith('/git/blobs')) {
            blob += 1;
            return response({sha: String(blob + 1).repeat(40)}, {status: 201});
        }
        if (pathname.endsWith('/git/trees')) {
            return response({sha: '4'.repeat(40)}, {status: 201});
        }
        throw new Error(`unexpected request after signing failure: ${url}`);
    };

    await assert.rejects(publishCatalogueCandidate({
        token: CREDENTIAL,
        intent: {
            baseSha,
            sequence: 8,
            branchName: 'catalogue/sequence-8',
            sourceDigest: sha256(sourceBytes),
            envelopeDigest: sha256(envelopeBytes),
        },
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
        now: new Date('2026-08-31T12:34:56.789Z'),
        signCommitImpl: async () => {
            throw new Error('synthetic signing failure');
        },
    }), /synthetic signing failure/);
    const writes = requests.filter(({options}) => options.method === 'POST')
        .map(({url}) => new URL(url).pathname);
    assert.equal(writes.includes('/repos/kyaulabs/prism-adapters/git/commits'), false);
    assert.equal(writes.includes('/repos/kyaulabs/prism-adapters/git/refs'), false);
    assert.equal(writes.includes('/repos/kyaulabs/prism-adapters/pulls'), false);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
