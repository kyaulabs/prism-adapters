// $KYAULabs: cli.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {createPrivateKey} from 'node:crypto';
import {
    lstat,
    mkdir,
    realpath,
    rename,
    writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';

import {createEnvelope, verifyEnvelope} from './envelope.js';
import {hydrateCatalogue, readCatalogueSource, validateCataloguePayload} from './payload.js';
import {
    EXPECTED_PUBLIC_KEY_SHA256,
    loadTrustedPublicKey,
} from './public-key.js';
import {readBoundedRegularFile} from './safe-file.js';
import {readHiddenLine} from './secret-prompt.js';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 65_536;
const ENCRYPTED_PKCS8_LABEL = Buffer.from('-----BEGIN ENCRYPTED PRIVATE KEY-----');
const HOME_PREFIXES = ['${HOME}/', '$HOME/', '~/'];
const MAX_PRIVATE_KEY_PATH_BYTES = 4096;

async function promptForPrivateKeyPath({stdin, stdout}) {
    const prompt = createInterface({input: stdin, output: stdout});
    try {
        return await prompt.question(
            'Private signing key path (must be outside this repository): ',
        );
    } finally {
        prompt.close();
    }
}

function resolvePrivateKeyPath({cwd, supplied, homeDirectory}) {
    if (typeof supplied !== 'string' || supplied.trim() === '' ||
        Buffer.byteLength(supplied) > MAX_PRIVATE_KEY_PATH_BYTES ||
        /[\u0000-\u001f\u007f]/.test(supplied)) {
        throw new Error('private signing key was not supplied');
    }
    const value = supplied.trim();
    for (const prefix of HOME_PREFIXES) {
        if (value.startsWith(prefix)) {
            return path.resolve(homeDirectory, value.slice(prefix.length));
        }
    }
    if (value.startsWith('~') || value.startsWith('$')) {
        throw new Error('private signing key path uses unsupported expansion');
    }
    return path.resolve(cwd, value);
}

function encryptedPkcs8(bytes) {
    return bytes.length >= ENCRYPTED_PKCS8_LABEL.length &&
        bytes.subarray(0, ENCRYPTED_PKCS8_LABEL.length).equals(ENCRYPTED_PKCS8_LABEL);
}

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

async function readOptionalFile(filePath) {
    try {
        return await readBoundedRegularFile({
            filePath,
            maximum: MAX_JSON_BYTES,
        });
    } catch (error) {
        if (error.cause?.code === 'ENOENT') return null;
        throw new Error('optional publisher file cannot be inspected');
    }
}

async function atomicWrite(filePath, bytes, mode = 0o644) {
    const temporary = `${filePath}.new`;
    await writeFile(temporary, bytes, {mode, flag: 'wx'});
    await rename(temporary, filePath);
}

async function loadPrivateSigningKey({
    cwd,
    stdin,
    stdout,
    homeDirectory,
    privateKeyPathPrompt,
    passphrasePrompt,
}) {
    if (!stdin?.isTTY || !stdout?.isTTY) {
        throw new Error('signing requires the human key custodian in an interactive terminal');
    }
    const supplied = await privateKeyPathPrompt({stdin, stdout});
    let repositoryRoot;
    let stat;
    let bytes;
    try {
        repositoryRoot = await realpath(cwd);
        const suppliedPath = resolvePrivateKeyPath({cwd, supplied, homeDirectory});
        stat = await lstat(suppliedPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 ||
            stat.size > MAX_PRIVATE_KEY_BYTES) {
            throw new Error('invalid-file');
        }
        const keyPath = await realpath(suppliedPath);
        const relative = path.relative(repositoryRoot, keyPath);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
            throw new Error('inside-repository');
        }
        bytes = await readBoundedRegularFile({
            filePath: suppliedPath,
            maximum: MAX_PRIVATE_KEY_BYTES,
        });
    } catch {
        throw new Error('private signing key is unavailable or inside the repository');
    }
    let passphrase = null;
    let privateKey;
    try {
        if (encryptedPkcs8(bytes)) {
            passphrase = await passphrasePrompt({
                stdin,
                stdout,
                prompt: 'Private signing key passphrase: ',
            });
            if (!Buffer.isBuffer(passphrase) || passphrase.length === 0) {
                throw new Error('private signing key is invalid');
            }
        }
        try {
            privateKey = passphrase === null
                ? createPrivateKey(bytes)
                : createPrivateKey({key: bytes, format: 'pem', passphrase});
        } catch {
            throw new Error('private signing key is invalid');
        }
    } finally {
        bytes.fill(0);
        passphrase?.fill(0);
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
    homeDirectory = homedir(),
    privateKeyPathPrompt = promptForPrivateKeyPath,
    passphrasePrompt = readHiddenLine,
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
    const privateKey = await loadPrivateSigningKey({
        cwd,
        stdin,
        stdout,
        homeDirectory,
        privateKeyPathPrompt,
        passphrasePrompt,
    });
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
