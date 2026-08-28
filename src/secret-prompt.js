// $KYAULabs: secret-prompt.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

const MAX_SECRET_BYTES = 4096;

function eraseLastCharacter(secret, length) {
    let next = length;
    do {
        next -= 1;
        const removed = secret[next];
        secret[next] = 0;
        if ((removed & 0xc0) !== 0x80) break;
    } while (next > 0);
    return next;
}

export async function readHiddenLine({stdin, stdout, prompt}) {
    if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== 'function') {
        throw new Error('signing requires the human key custodian in an interactive terminal');
    }
    const secret = Buffer.alloc(MAX_SECRET_BYTES);
    const wasRaw = stdin.isRaw === true;
    let length = 0;
    stdout.write(prompt);

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            stdin.removeListener('data', onData);
            stdin.removeListener('error', onError);
            stdin.removeListener('end', onEnd);
            stdin.removeListener('close', onClose);
            try {
                if (!wasRaw) stdin.setRawMode(false);
            } catch {
                error ??= new Error('interactive signing input failed');
            }
            try {
                stdin.pause?.();
                stdout.write('\n');
            } catch {
                error ??= new Error('interactive signing input failed');
            }
            if (error) {
                secret.fill(0);
                reject(error);
                return;
            }
            const result = Buffer.from(secret.subarray(0, length));
            secret.fill(0);
            resolve(result);
        };
        const onData = (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            try {
                for (const byte of bytes) {
                    if (byte === 0x03) {
                        finish(new Error('signing cancelled'));
                        return;
                    }
                    if (byte === 0x0a || byte === 0x0d) {
                        finish();
                        return;
                    }
                    if (byte === 0x08 || byte === 0x7f) {
                        if (length > 0) length = eraseLastCharacter(secret, length);
                        continue;
                    }
                    if (length >= MAX_SECRET_BYTES) {
                        finish(new Error('private signing key passphrase is invalid'));
                        return;
                    }
                    secret[length] = byte;
                    length += 1;
                }
            } finally {
                if (!Buffer.isBuffer(chunk)) bytes.fill(0);
            }
        };
        const onError = () => finish(new Error('interactive signing input failed'));
        const onEnd = () => finish(new Error('interactive signing input failed'));
        const onClose = () => finish(new Error('interactive signing input failed'));
        stdin.on('data', onData);
        stdin.once('error', onError);
        stdin.once('end', onEnd);
        stdin.once('close', onClose);
        try {
            if (!wasRaw) stdin.setRawMode(true);
            stdin.resume?.();
        } catch {
            finish(new Error('interactive signing input failed'));
        }
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
