// $KYAULabs: payload.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {readCatalogueSource} from '../src/catalogue-source.js';
import {
    hydrateCatalogue,
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

test('hydrates a deterministic six-day catalogue from allowlisted npm metadata', async () => {
    const requests = [];
    const source = readCatalogueSource(sourceValue);
    const payload = await hydrateCatalogue({
        source,
        sequence: 1,
        now: new Date('2026-08-28T00:00:00.000Z'),
        npmEvidence: async (request) => {
            requests.push(request);
            return {
                integrity,
                publishedAt: '2026-08-27T12:00:00.000Z',
            };
        },
    });

    assert.deepEqual(requests, [{
        packageName: '@kyaulabs/prism-php-web',
        version: '0.4.1',
    }]);
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
