// $KYAULabs: openpgp.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const GPG = '/usr/bin/gpg';
const IDENTITY = Object.freeze({name: 'Synthetic Publisher', email: 'synthetic@example.test'});
const PASSPHRASE = Buffer.from('synthetic publication commit passphrase');

function runGpg({homePath, args, input = Buffer.alloc(0), passphrase}) {
    return new Promise((resolve, reject) => {
        const child = spawn(GPG, [
            '--homedir', homePath,
            '--batch',
            '--yes',
            '--no-tty',
            ...(passphrase === undefined
                ? []
                : ['--pinentry-mode', 'loopback', '--passphrase-fd', '3']),
            ...args,
        ], {
            env: {HOME: homePath, GNUPGHOME: homePath, LANG: 'C', LC_ALL: 'C'},
            stdio: ['pipe', 'pipe', 'pipe', passphrase === undefined ? 'ignore' : 'pipe'],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
        child.once('error', reject);
        child.once('close', (code) => {
            if (code !== 0) {
                reject(new Error(`synthetic gpg failed: ${Buffer.concat(stderr).toString('utf8')}`));
                return;
            }
            resolve(Buffer.concat(stdout));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        if (passphrase !== undefined) {
            child.stdio[3].on('error', () => {});
            child.stdio[3].end(passphrase);
        }
    });
}

function fingerprints(listing) {
    const values = listing.toString('utf8').split('\n')
        .filter((line) => line.startsWith('fpr:'))
        .map((line) => line.split(':')[9]);
    if (values.length !== 2) throw new Error('synthetic OpenPGP fixture is invalid');
    return {primaryFingerprint: values[0], signingFingerprint: values[1]};
}

export async function openPgpFixture({subkeyUsage = 'sign'} = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'prism-openpgp-'));
    const generationHome = path.join(root, 'generation-home');
    const signingHomePath = path.join(root, 'signing-home');
    await mkdir(generationHome, {mode: 0o700});
    await runGpg({
        homePath: generationHome,
        args: [
            '--quick-generate-key',
            `${IDENTITY.name} <${IDENTITY.email}>`,
            'ed25519',
            'cert',
            '1d',
        ],
        passphrase: PASSPHRASE,
    });
    let listing = await runGpg({
        homePath: generationHome,
        args: ['--with-colons', '--with-subkey-fingerprint', '--list-keys', IDENTITY.email],
    });
    const primaryFingerprint = listing.toString('utf8').split('\n')
        .find((line) => line.startsWith('fpr:'))?.split(':')[9];
    if (!primaryFingerprint) throw new Error('synthetic OpenPGP fixture is invalid');
    await runGpg({
        homePath: generationHome,
        args: ['--quick-add-key', primaryFingerprint, 'ed25519', subkeyUsage, '1d'],
        passphrase: PASSPHRASE,
    });
    listing = await runGpg({
        homePath: generationHome,
        args: ['--with-colons', '--with-subkey-fingerprint', '--list-keys', primaryFingerprint],
    });
    const parsed = fingerprints(listing);
    const publicBytes = await runGpg({
        homePath: generationHome,
        args: ['--armor', '--export-options', 'export-minimal', '--export', primaryFingerprint],
    });
    const privateBytes = await runGpg({
        homePath: generationHome,
        args: ['--armor', '--export-secret-subkeys', primaryFingerprint],
        passphrase: PASSPHRASE,
    });
    const publicKeyPath = path.join(root, 'public.asc');
    const privateKeyPath = path.join(root, 'private.asc');
    const passphrasePath = path.join(root, 'passphrase');
    await writeFile(publicKeyPath, publicBytes, {mode: 0o644});
    await writeFile(privateKeyPath, privateBytes, {mode: 0o600});
    await writeFile(passphrasePath, PASSPHRASE, {mode: 0o600});
    return {
        root,
        publicKeyPath,
        privateKeyPath,
        passphrasePath,
        homePath: signingHomePath,
        passphrase: Buffer.from(PASSPHRASE),
        privateBytes,
        policy: Object.freeze({
            ...IDENTITY,
            ...parsed,
            publicExportSha256: createHash('sha256').update(publicBytes).digest('hex'),
        }),
    };
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
