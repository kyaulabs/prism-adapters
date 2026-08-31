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
    assert.match(`${readme}\n${security}\n${context}`, /CATALOGUE_SIGNING_ENABLED/);
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

test('documents exact activation and the superseding decision', async () => {
    const priorDecision = await readFile(
        new URL('../adr/0002-use-direct-pat-for-catalogue-publication.md', import.meta.url),
        'utf8',
    );
    const activationDecision = await readFile(
        new URL('../adr/0003-use-direct-pat-with-explicit-catalogue-activation.md', import.meta.url),
        'utf8',
    );

    assert.match(readme, /CATALOGUE_SIGNING_ENABLED.*exact value `true`/is);
    assert.match(security, /CATALOGUE_SIGNING_ENABLED.*exact string `true`/is);
    assert.match(context, /activation-gated.*CATALOGUE_SIGNING_ENABLED.*exact string `true`/is);
    assert.match(priorDecision, /## Status\n\nSuperseded by ADR-0003/);
    assert.match(activationDecision, /## Status\n\nAccepted/);
    assert.match(activationDecision, /supersedes ADR-0002/i);
    assert.match(activationDecision, /direct.*PAT/is);
});

test('documents sequence-safe direct publication authentication', () => {
    assert.match(context, /sequence branch.*immutable/i);
    assert.match(context, /exact.*recover/i);
    assert.match(context, /human.*merge/i);
    assert.match(readme, /repository dispatch/i);
    assert.match(readme, /three-day renewal/i);
    assert.match(readme, /manual recovery/i);
    assert.match(readme, /CATALOGUE_PUBLICATION_TOKEN/);
    assert.match(readme, /kyaulabs-bot/);
    assert.match(readme, /resource owner `kyaulabs`/i);
    assert.match(readme, /only `kyaulabs\/prism-adapters`/i);
    assert.match(readme, /Contents write.*Pull Requests write/is);
    assert.match(readme, /no Actions write/i);
    assert.match(readme, /catalogue:prepare-trigger/);
    assert.match(readme, /catalogue:publish-protected/);
    assert.match(readme, /GITHUB_TOKEN.*read-only/is);
    assert.match(security, /fine-grained PAT/i);
    assert.match(security, /opaque/i);
    assert.match(security, /separate.*Ed25519/is);
    assert.doesNotMatch(`${readme}\n${security}\n${context}`, /CATALOGUE_PUBLICATION_APP|GitHub App/);
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

test('documents publication commit-signing custody and sequence recovery', async () => {
    const decision = await readFile(
        new URL('../adr/0005-keep-publication-commit-signing-custody-outside-the-repository.md', import.meta.url),
        'utf8',
    );
    const documentation = `${readme}\n${security}\n${context}\n${decision}`;

    assert.match(documentation, /GnuPG `>=2[.]2[.]0 <3[.]0[.]0`/);
    assert.match(documentation, /kyaulabs-bot <actions@kyaulabs[.]com>/);
    assert.match(documentation, /CATALOGUE_COMMIT_SIGNING_PRIVATE_KEY/);
    assert.match(documentation, /CATALOGUE_COMMIT_SIGNING_PASSPHRASE/);
    assert.match(documentation, /outside every repository worktree/i);
    assert.match(documentation, /PRISM_SENSITIVE_PATHS/);
    assert.match(documentation, /passphrase.*separately/is);
    assert.match(documentation, /genuinely offline recovery copy/i);
    assert.match(documentation, /646340DAD3387E48F047B5C049659B98769C17D6/);
    assert.match(documentation, /0DFDEF5324CDBFFC5C4850379D81C6E3F694B7FE/);
    assert.match(documentation, /verified.*actions@kyaulabs[.]com/is);
    assert.match(security, /commit-signing.*exposure/is);
    assert.match(readme, /pull request 20.*catalogue\/sequence-2/is);
    assert.match(readme, /verified: true.*reason: valid/is);
    assert.match(security, /does not reuse.*catalogue.*key/is);
});

test('documents CI and automatic human-merged back-merges', () => {
    assert.match(readme, /pushes\s+and pull requests targeting `develop` and `main`/);
    assert.match(readme, /Allow GitHub Actions to create and approve pull\s+requests/);
    assert.match(readme, /`main` to `develop` back-merge pull request/);
    assert.match(readme, /Human review and merge remain required/);
});

// vim: ft=javascript sts=4 sw=4 ts=4 et :
