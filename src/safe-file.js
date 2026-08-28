// $KYAULabs: safe-file.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

export async function readBoundedRegularFile({filePath, maximum}) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0 ||
        typeof constants.O_NOFOLLOW !== 'number') {
        throw new Error('bounded file is invalid');
    }
    const scratch = Buffer.alloc(maximum + 1);
    let handle;
    let length = 0;
    try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size === 0 || stat.size > maximum) {
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
        throw new Error('bounded file is invalid', {cause: error});
    } finally {
        scratch.fill(0);
        await handle?.close().catch(() => {});
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
