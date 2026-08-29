// $KYAULabs: publication-state.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {decidePublication} from '../src/publication-state.js';

const intent = {
    baseSha: 'a'.repeat(40),
    sequence: 8,
    branchName: 'catalogue/sequence-8',
    sourceDigest: 'b'.repeat(64),
    envelopeDigest: 'c'.repeat(64),
};

function remote(overrides = {}) {
    return {
        mainSha: intent.baseSha,
        branch: null,
        openPullRequests: [],
        ...overrides,
    };
}

function exactBranch(overrides = {}) {
    return {
        name: intent.branchName,
        baseSha: intent.baseSha,
        commitSha: 'd'.repeat(40),
        sourceDigest: intent.sourceDigest,
        envelopeDigest: intent.envelopeDigest,
        changedFilesExact: true,
        commitCount: 1,
        ...overrides,
    };
}

test('creates an immutable sequence branch from empty remote state', () => {
    assert.deepEqual(decidePublication({intent, remote: remote()}), {
        action: 'CREATE_BRANCH',
        branchName: 'catalogue/sequence-8',
    });
});

test('recovers an exact branch by creating its missing pull request', () => {
    assert.deepEqual(decidePublication({
        intent,
        remote: remote({branch: exactBranch()}),
    }), {
        action: 'CREATE_PULL_REQUEST',
        branchName: 'catalogue/sequence-8',
    });
});

function exactPull(overrides = {}) {
    return {
        number: 17,
        headRef: intent.branchName,
        headSha: 'd'.repeat(40),
        baseRef: 'main',
        baseSha: intent.baseSha,
        ...overrides,
    };
}

test('reports exact branch and pull request state as idempotent success', () => {
    assert.deepEqual(decidePublication({
        intent,
        remote: remote({
            branch: exactBranch(),
            openPullRequests: [exactPull()],
        }),
    }), {
        action: 'IDEMPOTENT',
        branchName: 'catalogue/sequence-8',
        pullRequestNumber: 17,
    });
});

test('aborts when main moved after preparation', () => {
    assert.throws(
        () => decidePublication({
            intent,
            remote: remote({mainSha: 'e'.repeat(40)}),
        }),
        /catalogue publication base is stale/,
    );
});

const conflicts = [
    ['wrong branch name', remote({branch: exactBranch({name: 'catalogue/sequence-9'})})],
    ['wrong branch base', remote({branch: exactBranch({baseSha: 'e'.repeat(40)})})],
    ['wrong source bytes', remote({branch: exactBranch({sourceDigest: 'e'.repeat(64)})})],
    ['wrong envelope bytes', remote({branch: exactBranch({envelopeDigest: 'e'.repeat(64)})})],
    ['extra changed files', remote({branch: exactBranch({changedFilesExact: false})})],
    ['more than one commit', remote({branch: exactBranch({commitCount: 2})})],
    ['pull request without branch', remote({openPullRequests: [exactPull()]})],
    ['another publication pull request', remote({
        openPullRequests: [exactPull({headRef: 'catalogue/sequence-9'})],
    })],
    ['multiple publication pull requests', remote({
        branch: exactBranch(),
        openPullRequests: [exactPull(), exactPull({number: 18})],
    })],
    ['wrong pull request base ref', remote({
        branch: exactBranch(),
        openPullRequests: [exactPull({baseRef: 'develop'})],
    })],
    ['wrong pull request base SHA', remote({
        branch: exactBranch(),
        openPullRequests: [exactPull({baseSha: 'e'.repeat(40)})],
    })],
    ['wrong pull request head SHA', remote({
        branch: exactBranch(),
        openPullRequests: [exactPull({headSha: 'e'.repeat(40)})],
    })],
];

for (const [name, remoteState] of conflicts) {
    test(`fails closed for ${name}`, () => {
        assert.throws(
            () => decidePublication({intent, remote: remoteState}),
            /catalogue publication state conflicts/,
        );
    });
}

test('rejects malformed intent and remote state', () => {
    assert.throws(
        () => decidePublication({intent: {...intent, sequence: 0}, remote: remote()}),
        /catalogue publication intent is invalid/,
    );
    assert.throws(
        () => decidePublication({intent, remote: {...remote(), unknown: true}}),
        /catalogue publication state is invalid/,
    );
    assert.throws(
        () => decidePublication({
            intent,
            remote: remote({openPullRequests: Array.from({length: 101}, exactPull)}),
        }),
        /catalogue publication state is invalid/,
    );
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
