// $KYAULabs: npm-evidence.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {resolveNpmReleaseEvidence} from '../src/npm-evidence.js';

const integrity = `sha512-${Buffer.alloc(64, 29).toString('base64')}`;

test('rejects caller-selected npm package and prerelease values before fetch', async () => {
    let fetched = false;
    await assert.rejects(resolveNpmReleaseEvidence({
        packageName: '@other/prism-php-web',
        version: '0.4.2-rc.1',
        fetchImpl: async () => {
            fetched = true;
            throw new Error('must not fetch');
        },
    }), /npm release evidence is invalid/);
    assert.equal(fetched, false);
});

test('retries bounded npm availability and returns exact release evidence', async () => {
    const calls = [];
    const delays = [];
    const evidence = await resolveNpmReleaseEvidence({
        packageName: '@kyaulabs/prism-php-web',
        version: '0.4.2',
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            if (calls.length < 3) return new Response('{}', {status: 404});
            const body = JSON.stringify({
                versions: {'0.4.2': {dist: {integrity}}},
                time: {'0.4.2': '2026-08-28T12:00:00.000Z'},
            });
            return new Response(body, {
                status: 200,
                headers: {'content-length': String(Buffer.byteLength(body))},
            });
        },
        sleepImpl: async (milliseconds) => delays.push(milliseconds),
    });

    assert.deepEqual(evidence, {
        integrity,
        publishedAt: '2026-08-28T12:00:00.000Z',
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [1000, 1000]);
    assert.equal(calls[0].url,
        'https://registry.npmjs.org/%40kyaulabs%2Fprism-php-web');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.credentials, 'omit');
});

test('does not retry malformed exact npm evidence', async () => {
    const cases = [{
        versions: {'0.4.2': {dist: {}}},
        time: {'0.4.2': '2026-08-28T12:00:00.000Z'},
    }, {
        versions: {'0.4.2': {dist: {integrity: 'sha512-AAAA'}}},
        time: {'0.4.2': '2026-08-28T12:00:00.000Z'},
    }, {
        versions: {'0.4.1': {dist: {integrity}}},
        time: {'0.4.1': '2026-08-28T12:00:00.000Z'},
    }, {
        versions: {'0.4.2': {dist: {integrity}}},
        time: {'0.4.2': 'not-a-time'},
    }];
    for (const packument of cases) {
        let attempts = 0;
        await assert.rejects(resolveNpmReleaseEvidence({
            packageName: '@kyaulabs/prism-php-web',
            version: '0.4.2',
            fetchImpl: async () => {
                attempts += 1;
                return new Response(JSON.stringify(packument), {status: 200});
            },
            sleepImpl: async () => {
                throw new Error('invalid evidence must not sleep');
            },
        }), /npm release evidence is invalid/);
        assert.equal(attempts, 1);
    }
});

test('rejects parseable but noncanonical npm publication times', async () => {
    for (const publishedAt of [
        '2026-08-28',
        '2026-08-28T14:00:00+02:00',
    ]) {
        await assert.rejects(resolveNpmReleaseEvidence({
            packageName: '@kyaulabs/prism-php-web',
            version: '0.4.2',
            fetchImpl: async () => new Response(JSON.stringify({
                versions: {'0.4.2': {dist: {integrity}}},
                time: {'0.4.2': publishedAt},
            }), {status: 200}),
            sleepImpl: async () => {
                throw new Error('invalid evidence must not sleep');
            },
        }), /npm release evidence is invalid/);
    }
});

test('does not retry redirected or oversized npm responses', async () => {
    const responses = [
        new Response('', {status: 302, headers: {location: 'https://other.test/'}}),
        new Response('{}', {
            status: 200,
            headers: {'content-length': String(4 * 1024 * 1024 + 1)},
        }),
        new Response(Buffer.alloc(4 * 1024 * 1024 + 1, 7), {status: 200}),
    ];
    for (const response of responses) {
        let attempts = 0;
        await assert.rejects(resolveNpmReleaseEvidence({
            packageName: '@kyaulabs/prism-php-web',
            version: '0.4.2',
            fetchImpl: async () => {
                attempts += 1;
                return response;
            },
            sleepImpl: async () => {
                throw new Error('invalid evidence must not sleep');
            },
        }), /npm release evidence is invalid/);
        assert.equal(attempts, 1);
    }
});

test('stops after three unavailable npm attempts', async () => {
    let attempts = 0;
    const delays = [];
    await assert.rejects(resolveNpmReleaseEvidence({
        packageName: '@kyaulabs/prism-php-web',
        version: '0.4.2',
        fetchImpl: async () => {
            attempts += 1;
            throw new Error('registry unavailable');
        },
        sleepImpl: async (milliseconds) => delays.push(milliseconds),
    }), /npm release evidence is unavailable/);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [1000, 1000]);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
