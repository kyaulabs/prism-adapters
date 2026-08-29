// $KYAULabs: evidence-http.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    EvidenceInvalidError,
    EvidenceUnavailableError,
    requestBoundedJson,
} from '../src/evidence-http.js';

test('requests inert JSON through a fixed fail-closed HTTP profile', async () => {
    const calls = [];
    const value = await requestBoundedJson({
        url: 'https://example.test/evidence',
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            const body = JSON.stringify({ok: true});
            return new Response(body, {
                status: 200,
                headers: {'content-length': String(Buffer.byteLength(body))},
            });
        },
        maximumBytes: 1024,
        errorMessage: 'release evidence',
        headers: {'user-agent': 'prism-evidence-test'},
    });

    assert.deepEqual(value, {ok: true});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/evidence');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
});

test('classifies redirects, bad lengths, empty bodies, and malformed JSON as invalid', async () => {
    const responses = [
        new Response('', {status: 302, headers: {location: 'https://other.test/'}}),
        new Response('{}', {status: 200, headers: {'content-length': 'invalid'}}),
        new Response('', {status: 200}),
        new Response('{', {status: 200}),
    ];
    for (const response of responses) {
        await assert.rejects(requestBoundedJson({
            url: 'https://example.test/evidence',
            fetchImpl: async () => response,
            maximumBytes: 1024,
            errorMessage: 'release evidence',
        }), EvidenceInvalidError);
    }
});

test('classifies network failures and retryable statuses as unavailable', async () => {
    const fetches = [
        async () => { throw new Error('timeout'); },
        async () => new Response('{}', {status: 404}),
        async () => new Response('{}', {status: 429}),
        async () => new Response('{}', {status: 503}),
    ];
    for (const fetchImpl of fetches) {
        await assert.rejects(requestBoundedJson({
            url: 'https://example.test/evidence',
            fetchImpl,
            maximumBytes: 1024,
            errorMessage: 'release evidence',
        }), EvidenceUnavailableError);
    }
});

test('rejects a streamed response as soon as it crosses the byte bound', async () => {
    await assert.rejects(requestBoundedJson({
        url: 'https://example.test/evidence',
        fetchImpl: async () => new Response(Buffer.alloc(1025, 7), {status: 200}),
        maximumBytes: 1024,
        errorMessage: 'release evidence',
    }), /release evidence is invalid/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
