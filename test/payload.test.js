// $KYAULabs: payload.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    hydrateCatalogue,
    readCatalogueSource,
    validateCataloguePayload,
} from '../src/payload.js';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const sourceValue = {
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
};

function registryResponse(overrides = {}) {
    const body = JSON.stringify({
        versions: {
            '0.4.1': {dist: {integrity}},
        },
        time: {
            '0.4.1': '2026-08-27T12:00:00.000Z',
        },
        ...overrides,
    });
    return new Response(body, {
        status: 200,
        headers: {'content-length': String(Buffer.byteLength(body))},
    });
}

test('hydrates a deterministic six-day catalogue from allowlisted npm metadata', async () => {
    const requests = [];
    const source = readCatalogueSource(sourceValue);
    const payload = await hydrateCatalogue({
        source,
        sequence: 1,
        now: new Date('2026-08-28T00:00:00.000Z'),
        fetchImpl: async (url, options) => {
            requests.push({url, options});
            return registryResponse();
        },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url,
        'https://registry.npmjs.org/%40kyaulabs%2Fprism-php-web');
    assert.equal(requests[0].options.redirect, 'manual');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.deepEqual(payload, {
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
    });
});

test('accepts exact Core range ordering beyond Number precision', () => {
    const value = structuredClone(sourceValue);
    value.adapters[0].releases[0].coreRange =
        '>=9007199254740992.0.0 <9007199254740993.0.0';

    assert.doesNotThrow(() => readCatalogueSource(value));
});

for (const coreRange of ['>=1.0.0 <1.0.0', '>=2.0.0 <1.0.0']) {
    test(`rejects impossible Core range ${coreRange}`, () => {
        const value = structuredClone(sourceValue);
        value.adapters[0].releases[0].coreRange = coreRange;

        assert.throws(() => readCatalogueSource(value), /catalogue source is invalid/);
    });
}

test('rejects unreviewed source fields', () => {
    assert.throws(
        () => readCatalogueSource({...sourceValue, registry: 'https://example.test'}),
        /catalogue source is invalid/,
    );
});

test('rejects missing npm integrity', async () => {
    const source = readCatalogueSource(sourceValue);
    await assert.rejects(
        hydrateCatalogue({
            source,
            sequence: 1,
            now: new Date('2026-08-28T00:00:00.000Z'),
            fetchImpl: async () => registryResponse({versions: {'0.4.1': {dist: {}}}}),
        }),
        /npm release metadata is invalid/,
    );
});

test('rejects expired payloads', () => {
    const value = {
        schemaVersion: 1,
        catalogueId: 'kyaulabs/prism-adapters',
        sequence: 1,
        issuedAt: '2026-08-20T00:00:00.000Z',
        expiresAt: '2026-08-26T00:00:00.000Z',
        adapters: [{
            id: 'php-web',
            displayName: 'PHP/web',
            packageName: '@kyaulabs/prism-php-web',
            releases: [{
                version: '0.4.1',
                coreRange: '>=0.4.1 <0.5.0',
                bootstrapProtocol: 1,
                integrity,
                publishedAt: '2026-08-19T12:00:00.000Z',
                status: 'ACTIVE',
            }],
        }],
    };

    assert.throws(
        () => validateCataloguePayload({
            value,
            now: new Date('2026-08-28T00:00:00.000Z'),
        }),
        /catalogue is expired/,
    );
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
