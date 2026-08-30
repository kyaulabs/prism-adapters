// $KYAULabs: protected-runner.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {signProtectedCatalogue} from './protected-signing.js';

const REPOSITORY = 'kyaulabs/prism-adapters';
const DEFAULT_REF = 'refs/heads/main';
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/catalogue-signing.yml@${DEFAULT_REF}`;
const EVENTS = new Set(['repository_dispatch', 'schedule', 'workflow_dispatch']);
const SHA = /^[0-9a-f]{40}$/;

function trustedRunner(env) {
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
        path.isAbsolute(env.RUNNER_TEMP ?? '');
}

export async function runProtectedSigning({
    cwd = process.cwd(),
    env = process.env, // nosemgrep: prism-no-process-env -- GitHub Actions provenance is the protected runner boundary accepted in ADR-0094
    stdout = process.stdout,
    signImpl = signProtectedCatalogue,
} = {}) {
    const secretDirectory = path.isAbsolute(env.RUNNER_TEMP ?? '')
        ? path.join(env.RUNNER_TEMP, 'prism-catalogue-signing')
        : null;
    try {
        if (!trustedRunner(env)) {
            throw new Error('protected signing runner is not trusted');
        }
        const relative = path.relative(cwd, env.RUNNER_TEMP);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
            throw new Error('protected signing runner is not trusted');
        }
        const result = await signImpl({
            payloadPath: path.join(cwd, '.publisher', 'payload.json'),
            publicKeyPath: path.join(cwd, 'adapter-catalogue-public.pem'),
            privateKeyPath: path.join(secretDirectory, 'private.pem'),
            passphrasePath: path.join(secretDirectory, 'passphrase'),
            outputPath: path.join(cwd, 'catalogue.json'),
        });
        stdout.write(
            `protected catalogue sequence ${result.sequence} ` +
            `digest ${result.envelopeDigest}\n`,
        );
        return result;
    } catch (error) {
        if (error.message === 'protected signing runner is not trusted') throw error;
        throw new Error('protected catalogue signing failed', {cause: error});
    } finally {
        if (secretDirectory !== null) {
            await rm(secretDirectory, {recursive: true, force: true}).catch(() => {});
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runProtectedSigning().catch((error) => {
        process.stderr.write(`prism-adapters: ${error.message}\n`);
        process.exitCode = 1;
    });
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
