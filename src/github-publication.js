// $KYAULabs: github-publication.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import {createHash} from 'node:crypto';

import {decidePublication} from './publication-state.js';

const REPOSITORY_API = 'https://api.github.com/repos/kyaulabs/prism-adapters';
const API_VERSION = '2026-03-10';
const USER_AGENT = '@kyaulabs/prism-adapters-catalogue';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function publicationInvalid() {
    return new Error('GitHub publication state is invalid');
}

async function responseBytes(response) {
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
        throw publicationInvalid();
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw publicationInvalid();
    const chunks = [];
    let length = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            throw publicationInvalid();
        }
        chunks.push(chunk);
    }
    if (length === 0) throw publicationInvalid();
    return Buffer.concat(chunks, length);
}

async function publicationRequest({
    path,
    token,
    method = 'GET',
    body,
    expectedStatuses = [200],
    fetchImpl,
}) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
        throw publicationInvalid();
    }
    let response;
    try {
        response = await fetchImpl(`${REPOSITORY_API}${path}`, {
            method,
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers: {
                accept: 'application/vnd.github+json',
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'user-agent': USER_AGENT,
                'x-github-api-version': API_VERSION,
            },
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw publicationInvalid();
    }
    if (response?.redirected === true || !expectedStatuses.includes(response?.status)) {
        throw publicationInvalid();
    }
    if (response.status === 404 || response.status === 422) {
        return {status: response.status, value: null};
    }
    try {
        return {
            status: response.status,
            value: JSON.parse((await responseBytes(response)).toString('utf8')),
            link: response.headers?.get?.('link') ?? null,
        };
    } catch {
        throw publicationInvalid();
    }
}

function refSha(value, expectedRef) {
    if (value?.ref !== expectedRef || value?.object?.type !== 'commit' ||
        !/^[0-9a-f]{40}$/.test(value.object.sha ?? '')) {
        throw publicationInvalid();
    }
    return value.object.sha;
}

function contentBytes(value, expectedPath) {
    if (value?.type !== 'file' || value.path !== expectedPath || value.encoding !== 'base64' ||
        !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 4 * 1024 * 1024 ||
        typeof value.content !== 'string') {
        throw publicationInvalid();
    }
    const encoded = value.content.replaceAll('\n', '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== value.size || bytes.toString('base64') !== encoded) {
        throw publicationInvalid();
    }
    return bytes;
}

function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function inspectRemotePublication({token, intent, fetchImpl}) {
    const main = await publicationRequest({
        path: '/git/ref/heads/main',
        token,
        fetchImpl,
    });
    const mainSha = refSha(main.value, 'refs/heads/main');
    const pullsResponse = await publicationRequest({
        path: '/pulls?state=open&base=main&per_page=100',
        token,
        fetchImpl,
    });
    if (!Array.isArray(pullsResponse.value) || pullsResponse.value.length > 100 ||
        (typeof pullsResponse.link === 'string' && /rel="next"/.test(pullsResponse.link))) {
        throw publicationInvalid();
    }
    const openPullRequests = pullsResponse.value.map((pull) => {
        if (!Number.isSafeInteger(pull?.number) || pull.number <= 0 || pull.state !== 'open' ||
            typeof pull?.head?.ref !== 'string' ||
            !/^[0-9a-f]{40}$/.test(pull?.head?.sha ?? '') ||
            typeof pull?.base?.ref !== 'string' ||
            !/^[0-9a-f]{40}$/.test(pull?.base?.sha ?? '')) {
            throw publicationInvalid();
        }
        return {
            number: pull.number,
            headRef: pull.head.ref,
            headSha: pull.head.sha,
            baseRef: pull.base.ref,
            baseSha: pull.base.sha,
        };
    });
    const encodedBranch = encodeURIComponent(intent.branchName);
    const branchResponse = await publicationRequest({
        path: `/git/ref/heads/${encodedBranch}`,
        token,
        expectedStatuses: [200, 404],
        fetchImpl,
    });
    if (branchResponse.status === 404) {
        return {mainSha, branch: null, openPullRequests};
    }
    const commitSha = refSha(branchResponse.value, `refs/heads/${intent.branchName}`);
    const compare = await publicationRequest({
        path: `/compare/${intent.baseSha}...${commitSha}`,
        token,
        fetchImpl,
    });
    const comparison = compare.value;
    const expectedFiles = ['catalogue-source.json', 'catalogue.json'];
    const files = Array.isArray(comparison?.files) ? comparison.files : [];
    const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
    const changedFilesExact = files.length === 2 && expectedFiles.every((expectedPath) =>
        files.some(({filename, status}) => filename === expectedPath && status === 'modified'));
    const baseSha = comparison?.merge_base_commit?.sha;
    const commitCount = comparison?.total_commits;
    if (comparison?.ahead_by !== 1 || comparison?.behind_by !== 0 ||
        baseSha !== intent.baseSha || commitCount !== 1 || commits.length !== 1 ||
        commits[0]?.sha !== commitSha || commits[0]?.parents?.length !== 1 ||
        commits[0].parents[0]?.sha !== intent.baseSha) {
        throw publicationInvalid();
    }
    const [source, envelope] = await Promise.all([
        publicationRequest({
            path: `/contents/catalogue-source.json?ref=${commitSha}`,
            token,
            fetchImpl,
        }),
        publicationRequest({
            path: `/contents/catalogue.json?ref=${commitSha}`,
            token,
            fetchImpl,
        }),
    ]);
    return {
        mainSha,
        branch: {
            name: intent.branchName,
            baseSha,
            commitSha,
            sourceDigest: digest(contentBytes(source.value, 'catalogue-source.json')),
            envelopeDigest: digest(contentBytes(envelope.value, 'catalogue.json')),
            changedFilesExact,
            commitCount,
        },
        openPullRequests,
    };
}

function objectSha(value) {
    if (!/^[0-9a-f]{40}$/.test(value?.sha ?? '')) throw publicationInvalid();
    return value.sha;
}

async function createSequenceBranch({token, intent, sourceBytes, envelopeBytes, fetchImpl}) {
    const baseCommit = await publicationRequest({
        path: `/git/commits/${intent.baseSha}`,
        token,
        fetchImpl,
    });
    if (baseCommit.value?.sha !== intent.baseSha) throw publicationInvalid();
    const baseTree = objectSha(baseCommit.value?.tree);
    const sourceBlob = await publicationRequest({
        path: '/git/blobs',
        token,
        method: 'POST',
        body: {content: sourceBytes.toString('base64'), encoding: 'base64'},
        expectedStatuses: [201],
        fetchImpl,
    });
    const envelopeBlob = await publicationRequest({
        path: '/git/blobs',
        token,
        method: 'POST',
        body: {content: envelopeBytes.toString('base64'), encoding: 'base64'},
        expectedStatuses: [201],
        fetchImpl,
    });
    const tree = await publicationRequest({
        path: '/git/trees',
        token,
        method: 'POST',
        body: {
            base_tree: baseTree,
            tree: [
                {
                    path: 'catalogue-source.json',
                    mode: '100644',
                    type: 'blob',
                    sha: objectSha(sourceBlob.value),
                },
                {
                    path: 'catalogue.json',
                    mode: '100644',
                    type: 'blob',
                    sha: objectSha(envelopeBlob.value),
                },
            ],
        },
        expectedStatuses: [201],
        fetchImpl,
    });
    const commit = await publicationRequest({
        path: '/git/commits',
        token,
        method: 'POST',
        body: {
            message: `chore(catalogue): publish sequence ${intent.sequence}`,
            tree: objectSha(tree.value),
            parents: [intent.baseSha],
        },
        expectedStatuses: [201],
        fetchImpl,
    });
    const commitSha = objectSha(commit.value);
    const currentMain = await publicationRequest({
        path: '/git/ref/heads/main',
        token,
        fetchImpl,
    });
    if (refSha(currentMain.value, 'refs/heads/main') !== intent.baseSha) {
        throw new Error('catalogue publication base is stale');
    }
    const created = await publicationRequest({
        path: '/git/refs',
        token,
        method: 'POST',
        body: {ref: `refs/heads/${intent.branchName}`, sha: commitSha},
        expectedStatuses: [201, 422],
        fetchImpl,
    });
    if (created.status === 422) return;
    if (refSha(created.value, `refs/heads/${intent.branchName}`) !== commitSha) {
        throw publicationInvalid();
    }
}

async function createPublicationPullRequest({token, intent, title, body, fetchImpl}) {
    const created = await publicationRequest({
        path: '/pulls',
        token,
        method: 'POST',
        body: {
            title,
            head: intent.branchName,
            base: 'main',
            body,
            maintainer_can_modify: false,
            draft: false,
        },
        expectedStatuses: [201, 422],
        fetchImpl,
    });
    if (created.status === 422) return;
    if (!Number.isSafeInteger(created.value?.number) || created.value.number <= 0) {
        throw publicationInvalid();
    }
}

export async function publishCatalogueCandidate({
    token,
    intent,
    sourceBytes,
    envelopeBytes,
    title,
    body,
    fetchImpl = globalThis.fetch,
}) {
    if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length === 0 ||
        !Buffer.isBuffer(envelopeBytes) || envelopeBytes.length === 0 ||
        digest(sourceBytes) !== intent?.sourceDigest ||
        digest(envelopeBytes) !== intent?.envelopeDigest ||
        typeof title !== 'string' || title.length === 0 || title.length > 256 ||
        typeof body !== 'string' || body.length === 0 || body.length > 65_536) {
        throw publicationInvalid();
    }
    for (let transition = 0; transition < 3; transition += 1) {
        const remote = await inspectRemotePublication({token, intent, fetchImpl});
        const decision = decidePublication({intent, remote});
        if (decision.action === 'IDEMPOTENT') {
            return Object.freeze({
                state: decision.action,
                branchName: decision.branchName,
                pullRequestNumber: decision.pullRequestNumber,
            });
        }
        if (decision.action === 'CREATE_BRANCH') {
            await createSequenceBranch({token, intent, sourceBytes, envelopeBytes, fetchImpl});
            continue;
        }
        if (decision.action === 'CREATE_PULL_REQUEST') {
            await createPublicationPullRequest({token, intent, title, body, fetchImpl});
        }
    }
    throw new Error('catalogue publication state is ambiguous');
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
