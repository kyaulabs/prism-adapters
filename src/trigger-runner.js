// $KYAULabs: trigger-runner.js kyau@aura.kyaulabs 2026/08/29 -0700 Exp $

import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {run as prepareCatalogue} from './cli.js';
import {parsePublicationTrigger} from './publication-trigger.js';
import {
    readBoundedRegularFile,
    writePublicFileAtomically,
} from './safe-file.js';

const REPOSITORY = 'kyaulabs/prism-adapters';
const DEFAULT_REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/catalogue-signing.yml@${DEFAULT_REF}`;
const EVENTS = new Set(['repository_dispatch', 'schedule', 'workflow_dispatch']);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function trustedRunner({cwd, env}) {
    return env.GITHUB_ACTIONS === 'true' &&
        env.GITHUB_REPOSITORY === REPOSITORY &&
        env.GITHUB_REF === DEFAULT_REF &&
        SHA.test(env.GITHUB_SHA ?? '') &&
        env.GITHUB_WORKFLOW_REF === WORKFLOW_REF &&
        EVENTS.has(env.GITHUB_EVENT_NAME) &&
        path.isAbsolute(env.GITHUB_EVENT_PATH ?? '') &&
        path.isAbsolute(env.GITHUB_WORKSPACE ?? '') &&
        path.resolve(env.GITHUB_WORKSPACE) === path.resolve(cwd);
}

export async function runTriggerPreparation({
    cwd = process.cwd(),
    env = process.env, // nosemgrep: prism-no-process-env -- GitHub Actions provenance is the publication boundary accepted in ADR-0095
    stdout = process.stdout,
    prepareImpl = prepareCatalogue,
} = {}) {
    try {
        if (!trustedRunner({cwd, env})) {
            throw new Error('catalogue trigger runner is not trusted');
        }
        const [workspace, eventPath] = await Promise.all([
            realpath(cwd),
            realpath(env.GITHUB_EVENT_PATH),
        ]);
        const relative = path.relative(workspace, eventPath);
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) {
            throw new Error('catalogue trigger runner is not trusted');
        }
        const eventBytes = await readBoundedRegularFile({
            filePath: eventPath,
            maximum: 65_536,
        });
        const trigger = parsePublicationTrigger({
            eventName: env.GITHUB_EVENT_NAME,
            eventBytes,
        });
        const args = trigger.kind === 'release'
            ? ['prepare-release', trigger.version, trigger.mergeCommit]
            : ['prepare-renewal'];
        const prepared = await prepareImpl(args, {cwd, stdout});
        if (!Number.isSafeInteger(prepared?.sequence) || prepared.sequence <= 0 ||
            !DIGEST.test(prepared?.payloadDigest ?? '')) {
            throw new Error('catalogue preparation result is invalid');
        }
        const result = Object.freeze({
            baseSha: env.GITHUB_SHA,
            preparedSequence: prepared.sequence,
            payloadDigest: prepared.payloadDigest,
            trigger,
        });
        await writePublicFileAtomically({
            filePath: path.join(cwd, '.publisher', 'trigger.json'),
            bytes: Buffer.from(`${JSON.stringify({schemaVersion: 1, ...result})}\n`, 'utf8'),
        });
        return result;
    } catch (error) {
        if (error.message === 'catalogue trigger runner is not trusted') throw error;
        throw new Error('catalogue trigger preparation failed', {cause: error});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runTriggerPreparation().catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
