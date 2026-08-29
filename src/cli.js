// $KYAULabs: cli.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    realpath,
    rename,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

import {
    applyReleaseEvidence,
    renderCatalogueSource,
    sourceFromVerifiedCatalogue,
} from './catalogue-source.js';
import {verifyEnvelope} from './envelope.js';
import {resolvePrismReleaseEvidence} from './github-evidence.js';
import {resolveNpmReleaseEvidence} from './npm-evidence.js';
import {hydrateCatalogue} from './payload.js';
import {
    EXPECTED_PUBLIC_KEY_SHA256,
    loadTrustedPublicKey,
} from './public-key.js';
import {readBoundedRegularFile} from './safe-file.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
async function readRegularFile(filePath, maximum = MAX_JSON_BYTES) {
    try {
        return await readBoundedRegularFile({filePath, maximum});
    } catch (error) {
        if (error.cause?.code === 'ENOENT') {
            throw new Error('required publisher file is unavailable');
        }
        throw new Error('publisher file must be a bounded regular non-symlink file');
    }
}

async function openPrivateWorkDirectory({workDirectory, create}) {
    let handle;
    try {
        if (create) {
            await mkdir(workDirectory, {mode: 0o700}).catch((error) => {
                if (error?.code !== 'EEXIST') throw error;
            });
        }
        const pathStat = await lstat(workDirectory);
        if (pathStat.isSymbolicLink() || !pathStat.isDirectory() ||
            (pathStat.mode & 0o077) !== 0 ||
            typeof constants.O_DIRECTORY !== 'number' ||
            typeof constants.O_NOFOLLOW !== 'number') {
            throw new Error('invalid-directory');
        }
        handle = await open(
            workDirectory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const descriptorStat = await handle.stat();
        if (!descriptorStat.isDirectory() || descriptorStat.dev !== pathStat.dev ||
            descriptorStat.ino !== pathStat.ino || (descriptorStat.mode & 0o077) !== 0) {
            throw new Error('invalid-descriptor');
        }
        const descriptorPath = `/proc/self/fd/${handle.fd}`;
        if (await realpath(descriptorPath) !== await realpath(workDirectory)) {
            throw new Error('directory-identity-changed');
        }
        return {handle, descriptorPath};
    } catch {
        await handle?.close().catch(() => {});
        throw new Error('publisher work directory is invalid');
    }
}

async function atomicWrite(filePath, bytes, mode = 0o644) {
    const temporary = `${filePath}.new`;
    await writeFile(temporary, bytes, {mode, flag: 'wx'});
    await rename(temporary, filePath);
}

async function persistPreparation({cwd, workDirectory, source, payload}) {
    const sourceBytes = Buffer.from(renderCatalogueSource(source), 'utf8');
    const payloadBytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    const work = await openPrivateWorkDirectory({workDirectory, create: true});
    try {
        await atomicWrite(path.join(cwd, 'catalogue-source.json'), sourceBytes);
        await atomicWrite(
            path.join(work.descriptorPath, 'payload.json'),
            payloadBytes,
            0o600,
        );
    } finally {
        await work.handle.close();
    }
    return createHash('sha256').update(payloadBytes).digest('hex');
}

export async function run(args, {
    cwd = process.cwd(),
    expectedFingerprint = EXPECTED_PUBLIC_KEY_SHA256,
    githubFetchImpl = globalThis.fetch,
    npmFetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    now = new Date(),
    stdout = process.stdout,
} = {}) {
    const simpleCommand = Array.isArray(args) && args.length === 1 &&
        ['check-key', 'prepare-renewal', 'verify'].includes(args[0]);
    const releaseCommand = Array.isArray(args) && args.length === 3 &&
        args[0] === 'prepare-release';
    if (!simpleCommand && !releaseCommand) {
        throw new Error(
            'unknown command; use check-key, prepare-release, prepare-renewal, or verify',
        );
    }
    const publicKeyPath = path.join(cwd, 'adapter-catalogue-public.pem');
    const publicKey = await loadTrustedPublicKey({
        filePath: publicKeyPath,
        expectedFingerprint,
    });
    const command = args[0];
    if (command === 'check-key') {
        stdout.write(`trusted Ed25519 public key ${expectedFingerprint}\n`);
        return;
    }
    const cataloguePath = path.join(cwd, 'catalogue.json');
    if (command === 'verify') {
        const bytes = await readRegularFile(cataloguePath);
        const verified = verifyEnvelope({bytes, publicKey, now});
        stdout.write(
            `verified catalogue sequence ${verified.catalogue.sequence} ` +
            `digest ${verified.envelopeDigest} expires ${verified.catalogue.expiresAt}\n`,
        );
        return;
    }
    const workDirectory = path.join(cwd, '.publisher');
    if (command === 'prepare-renewal') {
        const existingBytes = await readRegularFile(cataloguePath);
        const verified = verifyEnvelope({
            bytes: existingBytes,
            publicKey,
            now,
            allowExpired: true,
        });
        const source = sourceFromVerifiedCatalogue(verified.catalogue);
        const payload = await hydrateCatalogue({
            source,
            sequence: verified.catalogue.sequence + 1,
            now,
            npmEvidence: (request) => resolveNpmReleaseEvidence({
                ...request,
                fetchImpl: npmFetchImpl,
                sleepImpl,
            }),
        });
        const digest = await persistPreparation({
            cwd,
            workDirectory,
            source,
            payload,
        });
        stdout.write(
            `prepared renewal catalogue sequence ${payload.sequence} digest ${digest} ` +
            `expires ${payload.expiresAt}\n`,
        );
        return Object.freeze({sequence: payload.sequence, payloadDigest: digest});
    }
    if (command === 'prepare-release') {
        const existingBytes = await readRegularFile(cataloguePath);
        const verified = verifyEnvelope({
            bytes: existingBytes,
            publicKey,
            now,
            allowExpired: true,
        });
        const evidence = await resolvePrismReleaseEvidence({
            version: args[1],
            mergeCommit: args[2],
            fetchImpl: githubFetchImpl,
        });
        const source = applyReleaseEvidence({
            current: verified.catalogue,
            evidence,
        });
        const payload = await hydrateCatalogue({
            source,
            sequence: verified.catalogue.sequence + 1,
            now,
            npmEvidence: (request) => resolveNpmReleaseEvidence({
                ...request,
                fetchImpl: npmFetchImpl,
                sleepImpl,
            }),
        });
        const digest = await persistPreparation({
            cwd,
            workDirectory,
            source,
            payload,
        });
        stdout.write(
            `prepared release ${evidence.version} catalogue sequence ${payload.sequence} ` +
            `digest ${digest} expires ${payload.expiresAt}\n`,
        );
        return Object.freeze({sequence: payload.sequence, payloadDigest: digest});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
