// $KYAULabs: catalogue-source.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyReleaseEvidence,
    readCatalogueSource,
    renderCatalogueSource,
    sourceFromVerifiedCatalogue,
} from '../src/catalogue-source.js';

const integrity = `sha512-${Buffer.alloc(64, 17).toString('base64')}`;
const current = {
    schemaVersion: 1,
    catalogueId: 'kyaulabs/prism-adapters',
    sequence: 7,
    issuedAt: '2026-08-22T00:00:00.000Z',
    expiresAt: '2026-08-28T00:00:00.000Z',
    adapters: [{
        id: 'php-web',
        displayName: 'PHP/web',
        packageName: '@kyaulabs/prism-php-web',
        releases: [{
            version: '0.4.1',
            coreRange: '>=0.4.1 <0.5.0',
            bootstrapProtocol: 1,
            integrity,
            publishedAt: '2026-08-21T12:00:00.000Z',
            status: 'ACTIVE',
        }],
    }],
};

test('renewal source preserves verified releases while removing npm evidence', () => {
    assert.deepEqual(sourceFromVerifiedCatalogue(current).adapters[0].releases, [{
        version: '0.4.1',
        coreRange: '>=0.4.1 <0.5.0',
        bootstrapProtocol: 1,
        status: 'ACTIVE',
    }]);
});

test('release evidence replaces only its exact version', () => {
    const source = applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.1',
                coreRange: '>=0.4.1 <0.6.0',
                bootstrapProtocol: 1,
                status: 'REVOKED',
            }, {
                version: '0.4.2',
                coreRange: '>=0.4.1 <0.6.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }]},
    });

    assert.deepEqual(source.adapters[0].releases.map(({version, status}) => ({version, status})), [
        {version: '0.4.1', status: 'REVOKED'},
        {version: '0.4.2', status: 'ACTIVE'},
    ]);
});

test('release evidence cannot change an existing adapter package identity', () => {
    assert.throws(() => applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/other',
            releases: [],
        }]},
    }), /release evidence conflicts with the verified catalogue/);
});

test('sorts new adapter releases by exact numeric SemVer', () => {
    const source = applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'node',
            displayName: 'Node',
            packageName: '@kyaulabs/prism-node',
            releases: [{
                version: '0.10.0',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }, {
                version: '0.9.0',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }]},
    });

    assert.deepEqual(source.adapters[0].releases.map(({version}) => version), [
        '0.9.0',
        '0.10.0',
    ]);
});

test('release evidence preserves unrelated verified adapters and statuses', () => {
    const withNode = structuredClone(current);
    withNode.adapters.push({
        id: 'node',
        displayName: 'Node',
        packageName: '@kyaulabs/prism-node',
        releases: [{
            ...withNode.adapters[0].releases[0],
            status: 'REVOKED',
        }],
    });
    const source = applyReleaseEvidence({
        current: withNode,
        evidence: {adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.2',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }]},
    });

    assert.equal(source.adapters[0].id, 'node');
    assert.equal(source.adapters[0].releases[0].status, 'REVOKED');
});

test('rejects evidence that duplicates a verified package under another ID', () => {
    assert.throws(() => applyReleaseEvidence({
        current,
        evidence: {adapters: [{
            id: 'other',
            displayName: 'Other',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.2',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                status: 'ACTIVE',
            }],
        }]},
    }), /catalogue source is invalid/);
});

test('sorts verified releases before deterministic renewal rendering', () => {
    const unordered = structuredClone(current);
    unordered.adapters[0].releases = [{
        ...unordered.adapters[0].releases[0],
        version: '0.10.0',
    }, {
        ...unordered.adapters[0].releases[0],
        version: '0.9.0',
    }];

    assert.deepEqual(
        sourceFromVerifiedCatalogue(unordered).adapters[0].releases.map(({version}) => version),
        ['0.9.0', '0.10.0'],
    );
});

test('renders deterministic pretty JSON with one trailing newline', () => {
    const source = sourceFromVerifiedCatalogue(current);

    assert.equal(renderCatalogueSource(source), `${JSON.stringify(source, null, 2)}\n`);
});

test('accepts exact Core range ordering beyond Number precision', () => {
    const value = structuredClone(sourceFromVerifiedCatalogue(current));
    value.adapters[0].releases[0].coreRange =
        '>=9007199254740992.0.0 <9007199254740993.0.0';

    assert.doesNotThrow(() => readCatalogueSource(value));
});

for (const coreRange of ['>=1.0.0 <1.0.0', '>=2.0.0 <1.0.0']) {
    test(`rejects impossible Core range ${coreRange}`, () => {
        const value = structuredClone(sourceFromVerifiedCatalogue(current));
        value.adapters[0].releases[0].coreRange = coreRange;

        assert.throws(() => readCatalogueSource(value), /catalogue source is invalid/);
    });
}

test('rejects unreviewed source fields', () => {
    const value = structuredClone(sourceFromVerifiedCatalogue(current));

    assert.throws(
        () => readCatalogueSource({...value, registry: 'https://example.test'}),
        /catalogue source is invalid/,
    );
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
