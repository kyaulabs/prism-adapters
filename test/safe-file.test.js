// $KYAULabs: safe-file.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    readBoundedPrivateFile,
    readBoundedRegularFile,
    writePublicFileAtomically,
} from '../src/safe-file.js';

test('reads a bounded regular file through one descriptor', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-safe-file-'));
    const filePath = path.join(directory, 'fixture.txt');
    await writeFile(filePath, 'public fixture bytes');

    const bytes = await readBoundedRegularFile({filePath, maximum: 64});

    assert.equal(bytes.toString('utf8'), 'public fixture bytes');
});

test('reads a bounded owner-only private file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-private-file-'));
    const filePath = path.join(directory, 'secret');
    await writeFile(filePath, 'synthetic secret', {mode: 0o600});

    const bytes = await readBoundedPrivateFile({filePath, maximum: 64});

    assert.equal(bytes.toString('utf8'), 'synthetic secret');
    bytes.fill(0);
});

test('rejects a group-readable private file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-private-file-'));
    const filePath = path.join(directory, 'secret');
    await writeFile(filePath, 'synthetic secret', {mode: 0o600});
    await chmod(filePath, 0o640);

    await assert.rejects(
        readBoundedPrivateFile({filePath, maximum: 64}),
        /bounded private file is invalid/,
    );
});

test('does not delete a pre-existing atomic-write collision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-public-write-'));
    const filePath = path.join(directory, 'catalogue.json');
    await writeFile(`${filePath}.new`, 'collision');

    await assert.rejects(
        writePublicFileAtomically({filePath, bytes: Buffer.from('public bytes')}),
    );
    assert.equal(await readFile(`${filePath}.new`, 'utf8'), 'collision');
    await assert.rejects(readFile(filePath), /ENOENT/);
});

test('rejects a symlink instead of following it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-safe-file-'));
    const target = path.join(directory, 'target.txt');
    const link = path.join(directory, 'fixture.txt');
    await writeFile(target, 'public fixture bytes');
    await symlink(target, link);

    await assert.rejects(
        readBoundedRegularFile({filePath: link, maximum: 64}),
        /bounded file is invalid/,
    );
});

test('rejects content larger than the configured maximum', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prism-safe-file-'));
    const filePath = path.join(directory, 'fixture.txt');
    await writeFile(filePath, Buffer.alloc(65, 7));

    await assert.rejects(
        readBoundedRegularFile({filePath, maximum: 64}),
        /bounded file is invalid/,
    );
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
