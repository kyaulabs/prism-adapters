// $KYAULabs: secret-prompt.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import test from 'node:test';

import {readHiddenLine} from '../src/secret-prompt.js';

function terminal() {
    const stdin = new PassThrough();
    const modes = [];
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (mode) => {
        stdin.isRaw = mode;
        modes.push(mode);
        return stdin;
    };
    let output = '';
    const stdout = {
        isTTY: true,
        write: (chunk) => { output += chunk; },
    };
    return {stdin, stdout, modes, output: () => output};
}

test('reads a bounded passphrase without echo and restores terminal mode', async () => {
    const fixture = terminal();
    const pending = readHiddenLine({
        stdin: fixture.stdin,
        stdout: fixture.stdout,
        prompt: 'Private signing key passphrase: ',
    });
    fixture.stdin.end(Buffer.from('synthetic-passphrase\n'));

    const secret = await pending;

    assert.equal(secret.toString('utf8'), 'synthetic-passphrase');
    assert.equal(fixture.output(), 'Private signing key passphrase: \n');
    assert.deepEqual(fixture.modes, [true, false]);
    secret.fill(0);
});

test('continues terminal cleanup when raw-mode restoration throws', async () => {
    const fixture = terminal();
    let paused = false;
    fixture.stdin.pause = () => { paused = true; return fixture.stdin; };
    fixture.stdin.setRawMode = (mode) => {
        fixture.modes.push(mode);
        if (!mode) throw new Error('synthetic raw-mode failure');
        fixture.stdin.isRaw = mode;
        return fixture.stdin;
    };
    const pending = readHiddenLine({
        stdin: fixture.stdin,
        stdout: fixture.stdout,
        prompt: 'Private signing key passphrase: ',
    });
    fixture.stdin.end(Buffer.from('synthetic-passphrase\n'));

    await assert.rejects(pending, /interactive signing input failed/);
    assert.equal(paused, true);
    assert.equal(fixture.output(), 'Private signing key passphrase: \n');
});

test('rejects a stream error and restores terminal mode', async () => {
    const fixture = terminal();
    const pending = readHiddenLine({
        stdin: fixture.stdin,
        stdout: fixture.stdout,
        prompt: 'Private signing key passphrase: ',
    });
    fixture.stdin.emit('error', new Error('synthetic input failure'));

    await assert.rejects(pending, /interactive signing input failed/);
    assert.equal(fixture.output(), 'Private signing key passphrase: \n');
    assert.deepEqual(fixture.modes, [true, false]);
});

test('cancels without returning secret bytes and restores terminal mode', async () => {
    const fixture = terminal();
    const pending = readHiddenLine({
        stdin: fixture.stdin,
        stdout: fixture.stdout,
        prompt: 'Private signing key passphrase: ',
    });
    fixture.stdin.end(Buffer.from([0x03]));

    await assert.rejects(pending, /signing cancelled/);
    assert.equal(fixture.output(), 'Private signing key passphrase: \n');
    assert.deepEqual(fixture.modes, [true, false]);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
