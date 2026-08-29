// $KYAULabs: publication-trigger.test.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {parsePublicationTrigger} from '../src/publication-trigger.js';

test('normalizes a scheduled renewal trigger', () => {
    assert.deepEqual(parsePublicationTrigger({
        eventName: 'schedule',
        eventBytes: Buffer.from('{"schedule":"0 6 */3 * *"}'),
    }), {kind: 'renewal'});
});

test('normalizes a closed Prism release dispatch trigger', () => {
    assert.deepEqual(parsePublicationTrigger({
        eventName: 'repository_dispatch',
        eventBytes: Buffer.from(JSON.stringify({
            action: 'prism-release-published',
            client_payload: {
                schemaVersion: 1,
                repository: 'kyaulabs/prism',
                version: '1.2.3',
                mergeCommit: 'a'.repeat(40),
            },
        })),
    }), {
        kind: 'release',
        version: '1.2.3',
        mergeCommit: 'a'.repeat(40),
    });
});

test('normalizes explicit manual renewal recovery', () => {
    assert.deepEqual(parsePublicationTrigger({
        eventName: 'workflow_dispatch',
        eventBytes: Buffer.from(JSON.stringify({
            inputs: {mode: 'renewal', version: '', merge_commit: ''},
        })),
    }), {kind: 'renewal'});
});

test('normalizes explicit manual release recovery', () => {
    assert.deepEqual(parsePublicationTrigger({
        eventName: 'workflow_dispatch',
        eventBytes: Buffer.from(JSON.stringify({
            inputs: {
                mode: 'release',
                version: '2.3.4',
                merge_commit: 'b'.repeat(40),
            },
        })),
    }), {
        kind: 'release',
        version: '2.3.4',
        mergeCommit: 'b'.repeat(40),
    });
});

const invalid = [
    ['empty bytes', 'schedule', Buffer.alloc(0)],
    ['malformed JSON', 'schedule', Buffer.from('{')],
    ['non-object JSON', 'schedule', Buffer.from('[]')],
    ['unknown event', 'pull_request', Buffer.from('{}')],
    ['unknown dispatch action', 'repository_dispatch', Buffer.from(JSON.stringify({
        action: 'other',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
        },
    }))],
    ['extra dispatch authority', 'repository_dispatch', Buffer.from(JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
            sequence: 8,
        },
    }))],
    ['wrong repository', 'repository_dispatch', Buffer.from(JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'someone/example',
            version: '1.2.3',
            mergeCommit: 'a'.repeat(40),
        },
    }))],
    ['prerelease version', 'repository_dispatch', Buffer.from(JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3-rc.1',
            mergeCommit: 'a'.repeat(40),
        },
    }))],
    ['uppercase commit', 'repository_dispatch', Buffer.from(JSON.stringify({
        action: 'prism-release-published',
        client_payload: {
            schemaVersion: 1,
            repository: 'kyaulabs/prism',
            version: '1.2.3',
            mergeCommit: 'A'.repeat(40),
        },
    }))],
    ['extra manual input', 'workflow_dispatch', Buffer.from(JSON.stringify({
        inputs: {mode: 'renewal', version: '', merge_commit: '', sequence: '8'},
    }))],
    ['renewal with release identifiers', 'workflow_dispatch', Buffer.from(JSON.stringify({
        inputs: {mode: 'renewal', version: '1.2.3', merge_commit: 'a'.repeat(40)},
    }))],
];

for (const [name, eventName, eventBytes] of invalid) {
    test(`rejects ${name}`, () => {
        assert.throws(
            () => parsePublicationTrigger({eventName, eventBytes}),
            /catalogue publication trigger is invalid/,
        );
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
