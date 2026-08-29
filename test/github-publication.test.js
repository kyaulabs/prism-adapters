// $KYAULabs: github-publication.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, verify} from 'node:crypto';
import test from 'node:test';

import {
    mintPublisherToken,
    publishCatalogueCandidate,
} from '../src/github-publication.js';

function response(value, {status = 200, headers = {}} = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {'content-type': 'application/json', ...headers},
    });
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

test('mints a repository- and permission-narrowed installation token', async () => {
    const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKeyBytes = Buffer.from(privateKey.export({
        type: 'pkcs8',
        format: 'pem',
    }));
    const requests = [];
    const now = new Date('2026-08-29T00:00:00.000Z');
    const fetchImpl = async (url, options) => {
        requests.push({url, options});
        if (requests.length === 1) {
            return response({
                id: 42,
                account: {login: 'kyaulabs'},
                repository_selection: 'selected',
            });
        }
        return response({
            token: 'opaque-synthetic-installation-token',
            expires_at: '2026-08-29T01:00:00.000Z',
            permissions: {contents: 'write', pull_requests: 'write'},
            repositories: [{
                id: 7,
                name: 'prism-adapters',
                full_name: 'kyaulabs/prism-adapters',
            }],
        }, {status: 201});
    };

    const result = await mintPublisherToken({
        appId: '12345',
        privateKeyBytes,
        fetchImpl,
        now,
    });

    assert.deepEqual(result, {
        token: 'opaque-synthetic-installation-token',
        expiresAt: '2026-08-29T01:00:00.000Z',
    });
    assert.equal(requests[0].url, 'https://api.github.com/repos/kyaulabs/prism-adapters/installation');
    const jwt = requests[0].options.headers.authorization.slice('Bearer '.length);
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url')), {
        alg: 'RS256',
        typ: 'JWT',
    });
    assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url')), {
        iat: 1787961540,
        exp: 1787962140,
        iss: 12345,
    });
    assert.equal(verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
    ), true);
    assert.equal(
        requests[1].url,
        'https://api.github.com/app/installations/42/access_tokens',
    );
    assert.deepEqual(JSON.parse(requests[1].options.body), {
        repositories: ['prism-adapters'],
        permissions: {contents: 'write', pull_requests: 'write'},
    });
});

test('rejects malformed or overbroad installation-token authority', async () => {
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    const privateKeyBytes = Buffer.from(privateKey.export({type: 'pkcs8', format: 'pem'}));
    const now = new Date('2026-08-29T00:00:00.000Z');

    await assert.rejects(mintPublisherToken({
        appId: '0',
        privateKeyBytes,
        fetchImpl: async () => {
            throw new Error('must not fetch');
        },
        now,
    }), /GitHub publication authentication is invalid/);

    const fetchImpl = async (url) => url.endsWith('/installation')
        ? response({id: 42, account: {login: 'kyaulabs'}, repository_selection: 'selected'})
        : response({
            token: 'opaque-token',
            expires_at: '2026-08-29T01:00:00.000Z',
            permissions: {contents: 'write', pull_requests: 'write', administration: 'write'},
            repositories: [{
                id: 7,
                name: 'prism-adapters',
                full_name: 'kyaulabs/prism-adapters',
            }],
        }, {status: 201});

    await assert.rejects(mintPublisherToken({
        appId: '12345',
        privateKeyBytes,
        fetchImpl,
        now,
    }), /GitHub publication authentication is invalid/);
});

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
        token: 'opaque-synthetic-installation-token',
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
        token: 'opaque-synthetic-installation-token',
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
    });

    assert.deepEqual(result, {
        state: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: 17,
    });
    assert.equal(requests.some(({options}) => options.method === 'POST'), false);
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
            return response({sha: commitSha}, {status: 201});
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
        token: 'opaque-synthetic-installation-token',
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
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
            return response({sha: commitSha}, {status: 201});
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
        token: 'opaque-synthetic-installation-token',
        intent,
        sourceBytes,
        envelopeBytes,
        title: 'chore(catalogue): publish sequence 8',
        body: 'Synthetic publication body',
        fetchImpl,
    }), {
        state: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: 17,
    });
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
