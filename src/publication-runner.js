// $KYAULabs: publication-runner.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import {createHash} from 'node:crypto';
import {rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {
    readCatalogueSource,
    renderCatalogueSource,
    sourceFromVerifiedCatalogue,
} from './catalogue-source.js';
import {verifyEnvelope} from './envelope.js';
import {publishCatalogueCandidate} from './github-publication.js';
import {publicationBranch} from './publication-state.js';
import {
    EXPECTED_PUBLIC_KEY_SHA256,
    loadTrustedPublicKey,
} from './public-key.js';
import {readBoundedRegularFile} from './safe-file.js';

const REPOSITORY = 'kyaulabs/prism-adapters';
const DEFAULT_REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/catalogue-signing.yml@${DEFAULT_REF}`;
const EVENTS = new Set(['repository_dispatch', 'schedule', 'workflow_dispatch']);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function trustedRunner({cwd, env}) {
    return env.GITHUB_ACTIONS === 'true' &&
        env.GITHUB_REPOSITORY === REPOSITORY &&
        env.GITHUB_REF === DEFAULT_REF &&
        SHA.test(env.GITHUB_SHA ?? '') &&
        env.GITHUB_WORKFLOW_REF === WORKFLOW_REF &&
        EVENTS.has(env.GITHUB_EVENT_NAME) &&
        env.CATALOGUE_SIGNING_ENVIRONMENT === 'catalogue-signing' &&
        env.RUNNER_DEBUG !== '1' &&
        env.ACTIONS_STEP_DEBUG !== 'true' &&
        env.ACTIONS_RUNNER_DEBUG !== 'true' &&
        path.isAbsolute(env.RUNNER_TEMP ?? '') &&
        path.relative(cwd, env.RUNNER_TEMP) !== '' &&
        (path.relative(cwd, env.RUNNER_TEMP) === '..' ||
            path.relative(cwd, env.RUNNER_TEMP).startsWith(`..${path.sep}`));
}

function parseTriggerRecord(bytes, env) {
    let record;
    try {
        record = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('catalogue publication trigger record is invalid');
    }
    if (!exactKeys(record, [
        'schemaVersion', 'baseSha', 'preparedSequence', 'payloadDigest', 'trigger',
    ]) || record.schemaVersion !== 1 || record.baseSha !== env.GITHUB_SHA ||
        !SHA.test(record.baseSha ?? '') ||
        !Number.isSafeInteger(record.preparedSequence) || record.preparedSequence <= 0 ||
        !DIGEST.test(record.payloadDigest ?? '') ||
        !exactKeys(record.trigger, record.trigger?.kind === 'release'
            ? ['kind', 'version', 'mergeCommit']
            : ['kind']) || !['release', 'renewal'].includes(record.trigger.kind) ||
        (record.trigger.kind === 'release' &&
            (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
                record.trigger.version ?? '',
            ) || !SHA.test(record.trigger.mergeCommit ?? '')))) {
        throw new Error('catalogue publication trigger record is invalid');
    }
    return record;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function pullRequestBody({verified, triggerRecord}) {
    const lines = [
        '## Catalogue publication',
        '',
        `- Sequence: ${verified.catalogue.sequence}`,
        `- Issued: ${verified.catalogue.issuedAt}`,
        `- Expires: ${verified.catalogue.expiresAt}`,
        `- Base commit: \`${triggerRecord.baseSha}\``,
        `- Trigger: ${triggerRecord.trigger.kind}`,
    ];
    if (triggerRecord.trigger.kind === 'release') {
        lines.push(`- Evidence commit: \`${triggerRecord.trigger.mergeCommit}\``);
    }
    lines.push('', '## Release evidence', '');
    for (const adapter of verified.catalogue.adapters) {
        for (const release of adapter.releases) {
            lines.push(
                `- ${adapter.packageName}@${release.version}`,
                `  - Adapter: ${adapter.displayName} (${adapter.id})`,
                `  - Core range: ${release.coreRange}`,
                `  - Bootstrap protocol: ${release.bootstrapProtocol}`,
                `  - Status: ${release.status}`,
                `  - npm integrity: ${release.integrity}`,
                `  - Published: ${release.publishedAt}`,
            );
        }
    }
    lines.push('', 'Human review and merge are required; automation cannot merge this pull request.', '');
    return lines.join('\n');
}

export async function runProtectedPublication({
    cwd = process.cwd(),
    env = process.env, // nosemgrep: prism-no-process-env -- GitHub Actions provenance is the publication boundary accepted in ADR-0095
    stdout = process.stdout,
    now = new Date(),
    expectedFingerprint = EXPECTED_PUBLIC_KEY_SHA256,
    publishImpl = publishCatalogueCandidate,
    fetchImpl = globalThis.fetch,
} = {}) {
    let commitSigningDirectory = null;
    try {
        if (!trustedRunner({cwd, env})) {
            throw new Error('protected publication runner is not trusted');
        }
        commitSigningDirectory = path.join(
            env.RUNNER_TEMP,
            'prism-publication-commit-signing',
        );
        const [sourceBytes, envelopeBytes, triggerBytes, publicKey] = await Promise.all([
            readBoundedRegularFile({
                filePath: path.join(cwd, 'catalogue-source.json'),
                maximum: 4 * 1024 * 1024,
            }),
            readBoundedRegularFile({
                filePath: path.join(cwd, 'catalogue.json'),
                maximum: 4 * 1024 * 1024,
            }),
            readBoundedRegularFile({
                filePath: path.join(cwd, '.publisher', 'trigger.json'),
                maximum: 65_536,
            }),
            loadTrustedPublicKey({
                filePath: path.join(cwd, 'adapter-catalogue-public.pem'),
                expectedFingerprint,
            }),
        ]);
        const triggerRecord = parseTriggerRecord(triggerBytes, env);
        let source;
        try {
            source = readCatalogueSource(JSON.parse(sourceBytes.toString('utf8')));
        } catch {
            throw new Error('catalogue publication source is invalid');
        }
        if (renderCatalogueSource(source) !== sourceBytes.toString('utf8')) {
            throw new Error('catalogue publication source is invalid');
        }
        const verified = verifyEnvelope({bytes: envelopeBytes, publicKey, now});
        if (verified.catalogue.sequence !== triggerRecord.preparedSequence ||
            verified.payloadDigest !== triggerRecord.payloadDigest ||
            renderCatalogueSource(sourceFromVerifiedCatalogue(verified.catalogue)) !==
                sourceBytes.toString('utf8')) {
            throw new Error('catalogue publication candidate is invalid');
        }
        const intent = Object.freeze({
            baseSha: triggerRecord.baseSha,
            sequence: triggerRecord.preparedSequence,
            branchName: publicationBranch(triggerRecord.preparedSequence),
            sourceDigest: sha256(sourceBytes),
            envelopeDigest: verified.envelopeDigest,
        });
        if (typeof env.CATALOGUE_PUBLICATION_TOKEN !== 'string' ||
            env.CATALOGUE_PUBLICATION_TOKEN.length === 0 ||
            env.CATALOGUE_PUBLICATION_TOKEN.length > 4096) {
            throw new Error('protected catalogue publication credential is invalid');
        }
        const result = await publishImpl({
            token: env.CATALOGUE_PUBLICATION_TOKEN,
            intent,
            sourceBytes,
            envelopeBytes,
            title: `chore(catalogue): publish sequence ${intent.sequence}`,
            body: pullRequestBody({verified, triggerRecord}),
            now,
            commitSigning: {
                publicKeyPath: path.join(cwd, 'publication-commit-signing-public.asc'),
                privateKeyPath: path.join(commitSigningDirectory, 'private.asc'),
                passphrasePath: path.join(commitSigningDirectory, 'passphrase'),
                homePath: path.join(commitSigningDirectory, 'gnupg'),
            },
            fetchImpl,
        });
        stdout.write(
            `published catalogue sequence ${intent.sequence} branch ${result.branchName} ` +
            `PR #${result.pullRequestNumber} state ${result.state}\n`,
        );
        return result;
    } catch (error) {
        if (error instanceof Error &&
            error.message === 'protected publication runner is not trusted') throw error;
        throw new Error('protected catalogue publication failed', {cause: error});
    } finally {
        if (commitSigningDirectory !== null) {
            await rm(commitSigningDirectory, {recursive: true, force: true}).catch(() => {});
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runProtectedPublication().catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
