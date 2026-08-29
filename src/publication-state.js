// $KYAULabs: publication-state.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BRANCH = /^catalogue\/sequence-[1-9]\d*$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

export function publicationBranch(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('catalogue publication intent is invalid');
    }
    return `catalogue/sequence-${sequence}`;
}

function validateIntent(intent) {
    if (!exactKeys(intent, [
        'baseSha', 'sequence', 'branchName', 'sourceDigest', 'envelopeDigest',
    ]) || !SHA.test(intent.baseSha ?? '') ||
        !Number.isSafeInteger(intent.sequence) || intent.sequence <= 0 ||
        intent.branchName !== publicationBranch(intent.sequence) ||
        !DIGEST.test(intent.sourceDigest ?? '') ||
        !DIGEST.test(intent.envelopeDigest ?? '')) {
        throw new Error('catalogue publication intent is invalid');
    }
}

function validBranch(branch) {
    return exactKeys(branch, [
        'name', 'baseSha', 'commitSha', 'sourceDigest', 'envelopeDigest',
        'changedFilesExact', 'commitCount',
    ]) && BRANCH.test(branch.name ?? '') && SHA.test(branch.baseSha ?? '') &&
        SHA.test(branch.commitSha ?? '') && DIGEST.test(branch.sourceDigest ?? '') &&
        DIGEST.test(branch.envelopeDigest ?? '') &&
        typeof branch.changedFilesExact === 'boolean' &&
        Number.isSafeInteger(branch.commitCount) && branch.commitCount >= 0;
}

function validPullRequest(pull) {
    return exactKeys(pull, ['number', 'headRef', 'headSha', 'baseRef', 'baseSha']) &&
        Number.isSafeInteger(pull.number) && pull.number > 0 &&
        typeof pull.headRef === 'string' && pull.headRef.length > 0 &&
        SHA.test(pull.headSha ?? '') && typeof pull.baseRef === 'string' &&
        pull.baseRef.length > 0 && SHA.test(pull.baseSha ?? '');
}

function validateRemote(remote) {
    if (!exactKeys(remote, ['mainSha', 'branch', 'openPullRequests']) ||
        !SHA.test(remote.mainSha ?? '') ||
        (remote.branch !== null && !validBranch(remote.branch)) ||
        !Array.isArray(remote.openPullRequests) || remote.openPullRequests.length > 100 ||
        remote.openPullRequests.some((pull) => !validPullRequest(pull))) {
        throw new Error('catalogue publication state is invalid');
    }
}

function conflict() {
    throw new Error('catalogue publication state conflicts');
}

export function decidePublication({intent, remote}) {
    validateIntent(intent);
    validateRemote(remote);
    if (remote.mainSha !== intent.baseSha) {
        throw new Error('catalogue publication base is stale');
    }
    const publicationPulls = remote.openPullRequests.filter(({headRef}) =>
        headRef.startsWith('catalogue/sequence-'));
    if (publicationPulls.length > 1 ||
        publicationPulls.some(({headRef}) => headRef !== intent.branchName)) {
        conflict();
    }
    const branch = remote.branch;
    if (branch === null) {
        if (publicationPulls.length !== 0) conflict();
        return Object.freeze({action: 'CREATE_BRANCH', branchName: intent.branchName});
    }
    if (branch.name !== intent.branchName || branch.baseSha !== intent.baseSha ||
        branch.sourceDigest !== intent.sourceDigest ||
        branch.envelopeDigest !== intent.envelopeDigest ||
        branch.changedFilesExact !== true || branch.commitCount !== 1) {
        conflict();
    }
    if (publicationPulls.length === 0) {
        return Object.freeze({
            action: 'CREATE_PULL_REQUEST',
            branchName: intent.branchName,
        });
    }
    const pull = publicationPulls[0];
    if (pull.baseRef !== 'main' || pull.baseSha !== intent.baseSha ||
        pull.headRef !== intent.branchName || pull.headSha !== branch.commitSha) {
        conflict();
    }
    return Object.freeze({
        action: 'IDEMPOTENT',
        branchName: intent.branchName,
        pullRequestNumber: pull.number,
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
