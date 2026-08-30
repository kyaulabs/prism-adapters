// $KYAULabs: safe-file.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {constants} from 'node:fs';
import {open, rename, unlink, writeFile} from 'node:fs/promises';

async function readBoundedFile({filePath, maximum, privateFile}) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0 ||
        typeof constants.O_NOFOLLOW !== 'number') {
        throw new Error(privateFile
            ? 'bounded private file is invalid'
            : 'bounded file is invalid');
    }
    const scratch = Buffer.alloc(maximum + 1);
    let handle;
    let length = 0;
    try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > maximum ||
            (privateFile && (stat.mode & 0o077) !== 0)) {
            throw new Error('invalid-file');
        }
        while (length < scratch.length) {
            const {bytesRead} = await handle.read(
                scratch,
                length,
                scratch.length - length,
                null,
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length === 0 || length > maximum) throw new Error('invalid-file');
        return Buffer.from(scratch.subarray(0, length));
    } catch (error) {
        throw new Error(privateFile
            ? 'bounded private file is invalid'
            : 'bounded file is invalid', {cause: error});
    } finally {
        scratch.fill(0);
        await handle?.close().catch(() => {});
    }
}

export async function readBoundedRegularFile({filePath, maximum}) {
    return readBoundedFile({filePath, maximum, privateFile: false});
}

export async function readBoundedPrivateFile({filePath, maximum}) {
    return readBoundedFile({filePath, maximum, privateFile: true});
}

export async function writePublicFileAtomically({filePath, bytes}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error('public output is invalid');
    }
    const temporary = `${filePath}.new`;
    let created = false;
    let committed = false;
    try {
        await writeFile(temporary, bytes, {mode: 0o644, flag: 'wx'});
        created = true;
        await rename(temporary, filePath);
        committed = true;
    } finally {
        if (created && !committed) await unlink(temporary).catch(() => {});
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
