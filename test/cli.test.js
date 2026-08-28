// $KYAULabs: cli.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {run} from '../src/cli.js';

const integrity = `sha512-${Buffer.alloc(64, 19).toString('base64')}`;

function keys() {
    const pair = generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({type: 'spki', format: 'der'});
    return {
        ...pair,
        fingerprint: createHash('sha256').update(der).digest('hex'),
        pem: pair.publicKey.export({type: 'spki', format: 'pem'}),
    };
}

function output() {
    let value = '';
    return {
        stream: {write: (chunk) => { value += chunk; }},
        value: () => value,
    };
}

async function repository() {
    const cwd = await mkdtemp(path.join(tmpdir(), 'prism-adapters-cli-'));
    const key = keys();
    await writeFile(path.join(cwd, 'adapter-catalogue-public.pem'), key.pem);
    await writeFile(path.join(cwd, 'catalogue-source.json'), JSON.stringify({
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
    }));
    return {cwd, key};
}

test('prepares sequence one without exposing signing-key authority', async () => {
    const {cwd, key} = await repository();
    const stdout = output();
    await run(['prepare'], {
        cwd,
        expectedFingerprint: key.fingerprint,
        now: new Date('2026-08-28T00:00:00.000Z'),
        stdout: stdout.stream,
        fetchImpl: async () => {
            const body = JSON.stringify({
                versions: {'0.4.1': {dist: {integrity}}},
                time: {'0.4.1': '2026-08-27T12:00:00.000Z'},
            });
            return new Response(body, {
                status: 200,
                headers: {'content-length': String(Buffer.byteLength(body))},
            });
        },
    });

    const payload = JSON.parse(await readFile(
        path.join(cwd, '.publisher', 'payload.json'),
        'utf8',
    ));
    assert.equal(payload.sequence, 1);
    assert.match(stdout.value(), /prepared catalogue sequence 1/);
});

test('sign rejects non-interactive execution before requesting a private key', async () => {
    const {cwd, key} = await repository();
    await mkdir(path.join(cwd, '.publisher'));
    await writeFile(path.join(cwd, '.publisher', 'payload.json'), '{}\n');

    await assert.rejects(
        run(['sign'], {
            cwd,
            expectedFingerprint: key.fingerprint,
            stdin: {isTTY: false},
            stdout: output().stream,
        }),
        /signing requires the human key custodian in an interactive terminal/,
    );
});

test('rejects unknown commands', async () => {
    await assert.rejects(run(['publish-now']), /unknown command/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
