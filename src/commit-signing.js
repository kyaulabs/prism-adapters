// $KYAULabs: commit-signing.js kyau@aura.kyaulabs 2026/08/31 -0700 Exp $

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {COMMIT_SIGNING_POLICY} from './commit-signing-policy.js';
import {readBoundedPrivateFile, readBoundedRegularFile} from './safe-file.js';

const SHA = /^[0-9a-f]{40}$/;
const IDENTITY_VALUE = /^[^<>\r\n\0]+$/;
const EMAIL = /^[^<>@\s\r\n\0]+@[^<>@\s\r\n\0]+$/;
const MAX_PUBLIC_BYTES = 65_536;
const MAX_PRIVATE_BYTES = 262_144;
const MAX_PASSPHRASE_BYTES = 4096;
const MAX_PROCESS_BYTES = 65_536;
const PROCESS_TIMEOUT_MS = 10_000;
const GPG_PATH = '/usr/bin/gpg';

function signingInvalid() {
    return new Error('publication commit signing failed');
}

export function canonicalCommit({
    treeSha,
    parentSha,
    message,
    now,
    policy = COMMIT_SIGNING_POLICY,
}) {
    if (!SHA.test(treeSha ?? '') || !SHA.test(parentSha ?? '') ||
        typeof message !== 'string' || message.length === 0 || message.length > 256 ||
        /[\r\n\0]/.test(message) || !(now instanceof Date) ||
        !Number.isFinite(now.getTime()) || !IDENTITY_VALUE.test(policy?.name ?? '') ||
        !EMAIL.test(policy?.email ?? '')) {
        throw signingInvalid();
    }
    const instant = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const epoch = Math.floor(instant.getTime() / 1000);
    const identity = `${policy.name} <${policy.email}>`;
    return Object.freeze({
        author: Object.freeze({
            name: policy.name,
            email: policy.email,
            date: instant.toISOString(),
        }),
        committer: Object.freeze({
            name: policy.name,
            email: policy.email,
            date: instant.toISOString(),
        }),
        payload: [
            `tree ${treeSha}`,
            `parent ${parentSha}`,
            `author ${identity} ${epoch} +0000`,
            `committer ${identity} ${epoch} +0000`,
            '',
            message,
        ].join('\n'),
    });
}

function runGpg({
    homePath,
    args,
    input = Buffer.alloc(0),
    descriptor3,
    descriptor3IsPassphrase = false,
    spawnImpl,
    gpgPath,
    processTimeoutMs = PROCESS_TIMEOUT_MS,
    maxProcessBytes = MAX_PROCESS_BYTES,
}) {
    return new Promise((resolve, reject) => {
        let child;
        let settled = false;
        let exceeded = false;
        const stdout = [];
        const stderr = [];
        let stdoutLength = 0;
        let stderrLength = 0;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(signingInvalid());
            else resolve(value);
        };
        try {
            child = spawnImpl(gpgPath, [
                '--homedir', homePath,
                '--batch',
                '--yes',
                '--no-tty',
                ...(descriptor3IsPassphrase
                    ? ['--pinentry-mode', 'loopback', '--passphrase-fd', '3']
                    : []),
                ...args,
            ], {
                shell: false,
                env: {HOME: homePath, GNUPGHOME: homePath, LANG: 'C', LC_ALL: 'C'},
                stdio: ['pipe', 'pipe', 'pipe', descriptor3 === undefined ? 'ignore' : 'pipe'],
            });
        } catch {
            reject(signingInvalid());
            return;
        }
        const timer = setTimeout(() => {
            exceeded = true;
            child.kill('SIGKILL');
        }, processTimeoutMs);
        const collect = (chunks, chunk, currentLength, assignLength) => {
            const bytes = Buffer.from(chunk);
            const nextLength = currentLength + bytes.length;
            assignLength(nextLength);
            if (nextLength > maxProcessBytes) {
                exceeded = true;
                child.kill('SIGKILL');
                return;
            }
            chunks.push(bytes);
        };
        child.stdout.on('data', (chunk) => collect(
            stdout,
            chunk,
            stdoutLength,
            (length) => { stdoutLength = length; },
        ));
        child.stderr.on('data', (chunk) => collect(
            stderr,
            chunk,
            stderrLength,
            (length) => { stderrLength = length; },
        ));
        child.once('error', () => finish(true));
        child.once('close', (code) => {
            if (exceeded || code !== 0) {
                finish(true);
                return;
            }
            finish(false, Object.freeze({
                stdout: Buffer.concat(stdout, stdoutLength),
                stderr: Buffer.concat(stderr, stderrLength),
            }));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        if (descriptor3 !== undefined) {
            child.stdio[3].on('error', () => {});
            child.stdio[3].end(descriptor3);
        }
    });
}

function validateKeyListing({publicListing, secretListing, policy}) {
    const publicLines = publicListing.toString('utf8').split('\n')
        .map((line) => line.split(':'));
    const secretLines = secretListing.toString('utf8').split('\n')
        .map((line) => line.split(':'));
    const publicFingerprints = publicLines
        .filter(([type]) => type === 'fpr')
        .map((fields) => fields[9]);
    const secretFingerprints = secretLines
        .filter(([type]) => type === 'fpr')
        .map((fields) => fields[9]);
    const identities = publicLines
        .filter(([type]) => type === 'uid')
        .map((fields) => fields[9]);
    const signingSubkey = publicLines.find(([type]) => type === 'sub');
    if (publicFingerprints[0] !== policy.primaryFingerprint ||
        !publicFingerprints.includes(policy.signingFingerprint) ||
        !secretFingerprints.includes(policy.signingFingerprint) ||
        !identities.includes(`${policy.name} <${policy.email}>`) ||
        !/[sS]/.test(signingSubkey?.[11] ?? '')) {
        throw signingInvalid();
    }
}

export async function signPublicationCommit({
    treeSha,
    parentSha,
    message,
    now,
    publicKeyPath,
    privateKeyPath,
    passphrasePath,
    homePath,
    policy = COMMIT_SIGNING_POLICY,
    spawnImpl = spawn,
    gpgPath = GPG_PATH,
    processTimeoutMs = PROCESS_TIMEOUT_MS,
    maxProcessBytes = MAX_PROCESS_BYTES,
}) {
    let privateBytes;
    let passphraseBytes;
    try {
        const canonical = canonicalCommit({treeSha, parentSha, message, now, policy});
        const publicBytes = await readBoundedRegularFile({
            filePath: publicKeyPath,
            maximum: MAX_PUBLIC_BYTES,
        });
        if (createHash('sha256').update(publicBytes).digest('hex') !==
            policy.publicExportSha256) {
            throw signingInvalid();
        }
        privateBytes = await readBoundedPrivateFile({
            filePath: privateKeyPath,
            maximum: MAX_PRIVATE_BYTES,
        });
        passphraseBytes = await readBoundedPrivateFile({
            filePath: passphrasePath,
            maximum: MAX_PASSPHRASE_BYTES,
        });
        await mkdir(homePath, {mode: 0o700});
        const invokeGpg = (options) => runGpg({
            ...options,
            homePath,
            spawnImpl,
            gpgPath,
            processTimeoutMs,
            maxProcessBytes,
        });
        const version = await invokeGpg({args: ['--version']});
        const versionMatch = /^gpg \(GnuPG\) (\d+)\.(\d+)(?:\.\d+)?/u.exec(
            version.stdout.toString('utf8'),
        );
        if (versionMatch === null || Number(versionMatch[1]) !== 2 ||
            Number(versionMatch[2]) < 2) {
            throw signingInvalid();
        }
        await invokeGpg({
            args: ['--import-options', 'import-minimal', '--import'],
            input: publicBytes,
        });
        await invokeGpg({
            args: ['--import'],
            input: privateBytes,
            descriptor3: passphraseBytes,
            descriptor3IsPassphrase: true,
        });
        const publicListing = await invokeGpg({
            args: [
                '--with-colons',
                '--with-subkey-fingerprint',
                '--list-keys',
                policy.primaryFingerprint,
            ],
        });
        const secretListing = await invokeGpg({
            args: [
                '--with-colons',
                '--with-subkey-fingerprint',
                '--list-secret-keys',
                policy.primaryFingerprint,
            ],
        });
        validateKeyListing({
            publicListing: publicListing.stdout,
            secretListing: secretListing.stdout,
            policy,
        });
        const signed = await invokeGpg({
            args: [
                '--armor',
                '--detach-sign',
                '--local-user',
                `${policy.signingFingerprint}!`,
                '--digest-algo',
                'SHA256',
                '--output',
                '-',
            ],
            input: Buffer.from(canonical.payload),
            descriptor3: passphraseBytes,
            descriptor3IsPassphrase: true,
        });
        const signature = signed.stdout.toString('utf8');
        if (!/^-----BEGIN PGP SIGNATURE-----\n[\s\S]+\n-----END PGP SIGNATURE-----\n$/.test(
            signature,
        )) {
            throw signingInvalid();
        }
        const signaturePath = path.join(homePath, 'commit-signature.asc');
        const payloadPath = path.join(homePath, 'commit-payload');
        await Promise.all([
            writeFile(signaturePath, signed.stdout, {mode: 0o600, flag: 'wx'}),
            writeFile(payloadPath, canonical.payload, {mode: 0o600, flag: 'wx'}),
        ]);
        await invokeGpg({
            args: ['--verify', signaturePath, payloadPath],
        });
        return Object.freeze({...canonical, signature});
    } catch {
        throw signingInvalid();
    } finally {
        privateBytes?.fill(0);
        passphraseBytes?.fill(0);
        if (typeof homePath === 'string') {
            await rm(homePath, {recursive: true, force: true}).catch(() => {});
        }
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
