// $KYAULabs: commit-signing.test.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {access, chmod, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {canonicalCommit, signPublicationCommit} from '../src/commit-signing.js';
import {openPgpFixture} from './helpers/openpgp.js';

test('constructs the exact canonical publication commit payload', () => {
    const result = canonicalCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
    });

    assert.deepEqual(result, {
        author: {
            name: 'kyaulabs-bot',
            email: 'actions@kyaulabs.com',
            date: '2026-08-31T12:34:56.000Z',
        },
        committer: {
            name: 'kyaulabs-bot',
            email: 'actions@kyaulabs.com',
            date: '2026-08-31T12:34:56.000Z',
        },
        payload: [
            `tree ${'4'.repeat(40)}`,
            `parent ${'a'.repeat(40)}`,
            'author kyaulabs-bot <actions@kyaulabs.com> 1788179696 +0000',
            'committer kyaulabs-bot <actions@kyaulabs.com> 1788179696 +0000',
            '',
            'chore(catalogue): publish sequence 8',
        ].join('\n'),
    });
    const hashed = spawnSync('git', ['hash-object', '-t', 'commit', '--stdin'], {
        input: result.payload,
        encoding: 'utf8',
    });
    assert.equal(hashed.status, 0);
    assert.equal(hashed.stdout, '4d207ed0b89fee32bb99c82a7d65143af5f94ebc\n');
});

test('rejects malformed canonical commit inputs', () => {
    const valid = {
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
    };
    for (const change of [
        {treeSha: '4'.repeat(39)},
        {parentSha: 'A'.repeat(40)},
        {message: 'subject\nbody'},
        {message: 'subject\0suffix'},
        {now: new Date(Number.NaN)},
        {policy: {name: 'bad\nname', email: 'actions@kyaulabs.com'}},
        {policy: {name: 'kyaulabs-bot', email: 'invalid'}},
    ]) {
        assert.throws(() => canonicalCommit({...valid, ...change}),
            /publication commit signing failed/);
    }
});

test('signs and locally verifies a canonical commit with a synthetic signing subkey', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));

    const processOptions = [];
    const result = await signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
        spawnImpl: (...args) => {
            processOptions.push({
                shell: args[2].shell,
                environmentKeys: Object.keys(args[2].env).sort(),
            });
            return spawn(...args);
        },
    });

    assert.match(result.signature,
        /^-----BEGIN PGP SIGNATURE-----[\s\S]+-----END PGP SIGNATURE-----\n$/);
    assert.match(result.payload, /^tree 4{40}\nparent a{40}\n/);
    assert.equal(result.author.email, 'synthetic@example.test');
    assert.equal(result.committer.email, 'synthetic@example.test');
    assert.ok(processOptions.length >= 7);
    for (const options of processOptions) {
        assert.equal(options.shell, false);
        assert.deepEqual(options.environmentKeys, [
            'GNUPGHOME', 'HOME', 'LANG', 'LC_ALL',
        ]);
    }
});

test('rejects mismatched signing policy without exposing synthetic secrets', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    const changes = [
        {publicExportSha256: '0'.repeat(64)},
        {primaryFingerprint: '0'.repeat(40)},
        {signingFingerprint: '0'.repeat(40)},
        {email: 'other@example.test'},
    ];
    for (const [index, change] of changes.entries()) {
        let error;
        try {
            await signPublicationCommit({
                treeSha: '4'.repeat(40),
                parentSha: 'a'.repeat(40),
                message: 'chore(catalogue): publish sequence 8',
                now: new Date('2026-08-31T12:34:56.789Z'),
                publicKeyPath: value.publicKeyPath,
                privateKeyPath: value.privateKeyPath,
                passphrasePath: value.passphrasePath,
                homePath: path.join(value.root, `mismatch-home-${index}`),
                policy: Object.freeze({...value.policy, ...change}),
            });
        } catch (caught) {
            error = caught;
        }
        assert.match(error?.message ?? '', /publication commit signing failed/);
        assert.doesNotMatch(error?.stack ?? '', new RegExp(value.passphrase.toString('utf8')));
        assert.doesNotMatch(error?.stack ?? '', new RegExp(value.privateBytes.toString('base64')));
    }
});

test('rejects a designated subkey without signing capability', async (t) => {
    const value = await openPgpFixture({subkeyUsage: 'auth'});
    t.after(() => rm(value.root, {recursive: true, force: true}));

    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
    }), /^Error: publication commit signing failed$/);
});

test('rejects unusable owner-only signing inputs with a generic error', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    await writeFile(value.passphrasePath, 'wrong synthetic passphrase', {mode: 0o600});
    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: path.join(value.root, 'wrong-passphrase-home'),
        policy: value.policy,
    }), /^Error: publication commit signing failed$/);

    await writeFile(value.passphrasePath, value.passphrase, {mode: 0o600});
    await chmod(value.privateKeyPath, 0o640);
    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: path.join(value.root, 'group-readable-home'),
        policy: value.policy,
    }), /^Error: publication commit signing failed$/);
});

test('rejects malformed detached-signature output', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    const malformedGpg = path.join(value.root, 'malformed-gpg');
    await writeFile(malformedGpg, [
        '#!/bin/sh',
        'for argument in "$@"; do',
        '    if [ "$argument" = "--detach-sign" ]; then',
        '        printf "%s\\n" "malformed signature"',
        '        exit 0',
        '    fi',
        'done',
        'exec /usr/bin/gpg "$@"',
        '',
    ].join('\n'), {mode: 0o700});
    await chmod(malformedGpg, 0o700);

    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
        gpgPath: malformedGpg,
    }), /^Error: publication commit signing failed$/);
});

test('bounds a stalled GnuPG process and removes its isolated home', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    const stalledGpg = path.join(value.root, 'stalled-gpg');
    await writeFile(stalledGpg, '#!/bin/sh\nexec sleep 1\n', {mode: 0o700});
    await chmod(stalledGpg, 0o700);
    const started = Date.now();

    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
        gpgPath: stalledGpg,
        processTimeoutMs: 20,
    }), /publication commit signing failed/);
    assert.ok(Date.now() - started < 500);
    await assert.rejects(access(value.homePath));
});

test('stops after bounded GnuPG output is exceeded', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    const noisyGpg = path.join(value.root, 'noisy-gpg');
    await writeFile(noisyGpg, '#!/bin/sh\nhead -c 1024 /dev/zero\n', {mode: 0o700});
    await chmod(noisyGpg, 0o700);
    let calls = 0;

    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
        gpgPath: noisyGpg,
        maxProcessBytes: 64,
        spawnImpl: (...args) => {
            calls += 1;
            return spawn(...args);
        },
    }), /publication commit signing failed/);
    assert.equal(calls, 1);

    const noisyStderrGpg = path.join(value.root, 'noisy-stderr-gpg');
    await writeFile(noisyStderrGpg,
        '#!/bin/sh\nhead -c 1024 /dev/zero >&2\n', {mode: 0o700});
    await chmod(noisyStderrGpg, 0o700);
    calls = 0;
    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: path.join(value.root, 'stderr-home'),
        policy: value.policy,
        gpgPath: noisyStderrGpg,
        maxProcessBytes: 64,
        spawnImpl: (...args) => {
            calls += 1;
            return spawn(...args);
        },
    }), /publication commit signing failed/);
    assert.equal(calls, 1);
});

test('rejects a GnuPG version outside the trusted range', async (t) => {
    const value = await openPgpFixture();
    t.after(() => rm(value.root, {recursive: true, force: true}));
    const futureGpg = path.join(value.root, 'future-gpg');
    await writeFile(futureGpg, [
        '#!/bin/sh',
        'for argument in "$@"; do',
        '    if [ "$argument" = "--version" ]; then',
        '        printf "%s\\n" "gpg (GnuPG) 3.0.0"',
        '        exit 0',
        '    fi',
        'done',
        'exec /usr/bin/gpg "$@"',
        '',
    ].join('\n'), {mode: 0o700});
    await chmod(futureGpg, 0o700);

    await assert.rejects(signPublicationCommit({
        treeSha: '4'.repeat(40),
        parentSha: 'a'.repeat(40),
        message: 'chore(catalogue): publish sequence 8',
        now: new Date('2026-08-31T12:34:56.789Z'),
        publicKeyPath: value.publicKeyPath,
        privateKeyPath: value.privateKeyPath,
        passphrasePath: value.passphrasePath,
        homePath: value.homePath,
        policy: value.policy,
        gpgPath: futureGpg,
    }), /publication commit signing failed/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
