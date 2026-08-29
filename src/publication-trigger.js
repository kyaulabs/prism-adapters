// $KYAULabs: publication-trigger.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

export function parsePublicationTrigger({eventName, eventBytes}) {
    if (!Buffer.isBuffer(eventBytes) || eventBytes.length === 0 ||
        eventBytes.length > 65_536) {
        throw new Error('catalogue publication trigger is invalid');
    }
    let event;
    try {
        event = JSON.parse(eventBytes.toString('utf8'));
    } catch {
        throw new Error('catalogue publication trigger is invalid');
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('catalogue publication trigger is invalid');
    }
    if (eventName === 'schedule') return Object.freeze({kind: 'renewal'});
    if (eventName === 'repository_dispatch') {
        const payload = event.client_payload;
        if (event.action === 'prism-release-published' && exactKeys(payload, [
            'schemaVersion', 'repository', 'version', 'mergeCommit',
        ]) && payload.schemaVersion === 1 && payload.repository === 'kyaulabs/prism' &&
            RELEASE.test(payload.version ?? '') && COMMIT.test(payload.mergeCommit ?? '')) {
            return Object.freeze({
                kind: 'release',
                version: payload.version,
                mergeCommit: payload.mergeCommit,
            });
        }
    }
    if (eventName === 'workflow_dispatch' && exactKeys(event.inputs, [
        'mode', 'version', 'merge_commit',
    ])) {
        if (event.inputs.mode === 'renewal' && event.inputs.version === '' &&
            event.inputs.merge_commit === '') {
            return Object.freeze({kind: 'renewal'});
        }
        if (event.inputs.mode === 'release' && RELEASE.test(event.inputs.version ?? '') &&
            COMMIT.test(event.inputs.merge_commit ?? '')) {
            return Object.freeze({
                kind: 'release',
                version: event.inputs.version,
                mergeCommit: event.inputs.merge_commit,
            });
        }
    }
    throw new Error('catalogue publication trigger is invalid');
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
