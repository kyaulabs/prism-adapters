// $KYAULabs: cli.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {createPrivateKey} from 'node:crypto';
import {
    lstat,
    mkdir,
    readFile,
    realpath,
    rename,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';

import {createEnvelope, verifyEnvelope} from './envelope.js';
import {hydrateCatalogue, readCatalogueSource, validateCataloguePayload} from './payload.js';
import {
    EXPECTED_PUBLIC_KEY_SHA256,
    loadTrustedPublicKey,
} from './public-key.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 65_536;

async function readRegularFile(filePath, maximum = MAX_JSON_BYTES) {
    let stat;
    try {
        stat = await lstat(filePath);
    } catch {
        throw new Error('required publisher file is unavailable');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > maximum) {
        throw new Error('publisher file must be a bounded regular non-symlink file');
    }
    return readFile(filePath);
}

async function readOptionalFile(filePath) {
    try {
        await lstat(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error('optional publisher file cannot be inspected');
    }
    return readRegularFile(filePath);
}

async function atomicWrite(filePath, bytes, mode = 0o644) {
    const temporary = `${filePath}.new`;
    await writeFile(temporary, bytes, {mode, flag: 'wx'});
    await rename(temporary, filePath);
}

async function loadPrivateSigningKey({cwd, stdin, stdout}) {
    if (!stdin?.isTTY || !stdout?.isTTY) {
        throw new Error('signing requires the human key custodian in an interactive terminal');
    }
    const prompt = createInterface({input: stdin, output: stdout});
    let supplied;
    try {
        supplied = await prompt.question('Private signing key path (must be outside this repository): ');
    } finally {
        prompt.close();
    }
    if (typeof supplied !== 'string' || supplied.trim() === '') {
        throw new Error('private signing key was not supplied');
    }
    let repositoryRoot;
    let keyPath;
    let stat;
    let bytes;
    try {
        repositoryRoot = await realpath(cwd);
        const suppliedPath = path.resolve(cwd, supplied.trim());
        stat = await lstat(suppliedPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 ||
            stat.size > MAX_PRIVATE_KEY_BYTES) {
            throw new Error('invalid-file');
        }
        keyPath = await realpath(suppliedPath);
        const relative = path.relative(repositoryRoot, keyPath);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
            throw new Error('inside-repository');
        }
        bytes = await readFile(keyPath);
    } catch {
        throw new Error('private signing key is unavailable or inside the repository');
    }
    let privateKey;
    try {
        privateKey = createPrivateKey(bytes);
    } catch {
        throw new Error('private signing key is invalid');
    } finally {
        if (bytes) bytes.fill(0);
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('private signing key must use Ed25519');
    }
    return privateKey;
}

export async function run(args, {
    cwd = process.cwd(),
    expectedFingerprint = EXPECTED_PUBLIC_KEY_SHA256,
    fetchImpl = globalThis.fetch,
    now = new Date(),
    stdin = process.stdin,
    stdout = process.stdout,
} = {}) {
    if (!Array.isArray(args) || args.length !== 1 ||
        !['check-key', 'prepare', 'sign', 'verify'].includes(args[0])) {
        throw new Error('unknown command; use check-key, prepare, sign, or verify');
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
    const payloadPath = path.join(workDirectory, 'payload.json');
    if (command === 'prepare') {
        const sourceBytes = await readRegularFile(path.join(cwd, 'catalogue-source.json'));
        let sourceValue;
        try {
            sourceValue = JSON.parse(sourceBytes.toString('utf8'));
        } catch {
            throw new Error('catalogue source is invalid JSON');
        }
        const source = readCatalogueSource(sourceValue);
        const existing = await readOptionalFile(cataloguePath);
        const sequence = existing === null ? 1 : verifyEnvelope({
            bytes: existing,
            publicKey,
            now,
            allowExpired: true,
        }).catalogue.sequence + 1;
        const payload = await hydrateCatalogue({
            source,
            sequence,
            now,
            fetchImpl,
        });
        await mkdir(workDirectory, {recursive: true, mode: 0o700});
        await atomicWrite(payloadPath, Buffer.from(`${JSON.stringify(payload)}\n`), 0o600);
        stdout.write(
            `prepared catalogue sequence ${payload.sequence} expires ${payload.expiresAt}\n`,
        );
        return;
    }
    if (!stdin?.isTTY || !stdout?.isTTY) {
        throw new Error('signing requires the human key custodian in an interactive terminal');
    }
    const payloadBytes = await readRegularFile(payloadPath);
    let payload;
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        throw new Error('prepared catalogue payload is invalid JSON');
    }
    validateCataloguePayload({value: payload, now});
    const privateKey = await loadPrivateSigningKey({cwd, stdin, stdout});
    const envelopeBytes = createEnvelope({payload, privateKey, publicKey});
    await atomicWrite(cataloguePath, envelopeBytes);
    const verified = verifyEnvelope({bytes: envelopeBytes, publicKey, now});
    stdout.write(
        `signed catalogue sequence ${verified.catalogue.sequence} ` +
        `digest ${verified.envelopeDigest}\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
