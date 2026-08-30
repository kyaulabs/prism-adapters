// $KYAULabs: documentation.test.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8');
const context = await readFile(new URL('../CONTEXT.md', import.meta.url), 'utf8');
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

test('documents protected signing custody and recovery', () => {
    assert.match(context, /protected signing environment/);
    assert.match(readme, /catalogue-signing/);
    assert.match(readme, /CATALOGUE_SIGNING_ENABLED/);
    assert.match(readme, /catalogue:sign-protected/);
    assert.doesNotMatch(readme, /Sign as the human key custodian/);
    assert.match(security, /environment-scoped GitHub Actions secrets/);
    assert.match(security, /offline recovery cop(?:y|ies)/);
    assert.match(security, /re-provision/i);
    assert.match(security, /successor|succession/i);
    assert.match(security, /Core trust-root rotation/);
    assert.match(security, /Actions log retention/);
    assert.equal(manifest.scripts['catalogue:sign'], undefined);
    assert.equal(
        manifest.scripts['catalogue:sign-protected'],
        'node src/protected-runner.js',
    );
});

test('documents sequence-safe App-backed publication', () => {
    assert.match(context, /sequence branch.*immutable/i);
    assert.match(context, /exact.*recover/i);
    assert.match(context, /human.*merge/i);
    assert.match(readme, /repository dispatch/i);
    assert.match(readme, /three-day renewal/i);
    assert.match(readme, /manual recovery/i);
    assert.match(readme, /CATALOGUE_PUBLICATION_APP_ID/);
    assert.match(readme, /CATALOGUE_PUBLICATION_APP_PRIVATE_KEY/);
    assert.match(readme, /catalogue:prepare-trigger/);
    assert.match(readme, /catalogue:publish-protected/);
    assert.match(readme, /contents.*pull-request write/is);
    assert.match(readme, /GITHUB_TOKEN.*read-only/is);
    assert.match(security, /one hour/i);
    assert.match(security, /opaque/i);
    assert.match(security, /App.*succession/is);
    assert.match(security, /App.*exposure/is);
    assert.match(security, /separate.*Ed25519/is);
    assert.doesNotMatch(readme, /workflow may push `main`/);
    assert.equal(
        manifest.scripts['catalogue:prepare-trigger'],
        'node src/trigger-runner.js',
    );
    assert.equal(
        manifest.scripts['catalogue:publish-protected'],
        'node src/publication-runner.js',
    );
    assert.equal(manifest.scripts['catalogue:publish'], undefined);
});

test('documents CI and automatic human-merged back-merges', () => {
    assert.match(readme, /pushes\s+and pull requests targeting `develop` and `main`/);
    assert.match(readme, /Allow GitHub Actions to create and approve pull\s+requests/);
    assert.match(readme, /`main` to `develop` back-merge pull request/);
    assert.match(readme, /Human review and merge remain required/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
