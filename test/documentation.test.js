// $KYAULabs: documentation.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('documents evidence-backed preparation commands', () => {
    assert.match(readme, /catalogue:prepare-release -- <stable-version> <immutable-commit>/);
    assert.match(readme, /catalogue:prepare-renewal/);
    assert.match(readme, /generated.*catalogue-source[.]json/is);
    assert.doesNotMatch(readme, /Edit only `catalogue-source[.]json`/);
    assert.equal(
        manifest.scripts['catalogue:prepare-release'],
        'node src/cli.js prepare-release',
    );
    assert.equal(
        manifest.scripts['catalogue:prepare-renewal'],
        'node src/cli.js prepare-renewal',
    );
    const legacyPrepare = ['catalogue', 'prepare'].join(':');
    assert.equal(manifest.scripts[legacyPrepare], undefined);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
