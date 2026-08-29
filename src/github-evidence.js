// $KYAULabs: github-evidence.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {readCatalogueSource} from './catalogue-source.js';
import {
    EvidenceInvalidError,
    EvidenceUnavailableError,
    requestBoundedJson,
} from './evidence-http.js';

const REPOSITORY = 'kyaulabs/prism';
const API_ORIGIN = `https://api.github.com/repos/${REPOSITORY}`;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONFIGURATION_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE_PATH = /^(?:[a-z0-9._-]+\/)*[a-z0-9._-]+$/;
const PACKAGE_NAME = /^@kyaulabs\/[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONFIGURATION_KEYS = [
    'adapterReleases',
    'managedBy',
    'packages',
    'schemaVersion',
    'versionPolicy',
];
const DECLARATION_KEYS = [
    'bootstrapProtocol',
    'coreRange',
    'displayName',
    'id',
    'package',
    'status',
];

function invalid() {
    return new EvidenceInvalidError('Prism release evidence is invalid');
}

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

async function githubRequest(pathname, fetchImpl) {
    return requestBoundedJson({
        url: `${API_ORIGIN}${pathname}`,
        fetchImpl,
        maximumBytes: MAX_RESPONSE_BYTES,
        errorMessage: 'Prism release evidence',
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': '@kyaulabs/prism-adapters-catalogue',
            'x-github-api-version': '2022-11-28',
        },
    });
}

function contentJson(response, pathname, maximumBytes) {
    if (response?.type !== 'file' || response?.encoding !== 'base64' ||
        response?.path !== pathname || !Number.isSafeInteger(response?.size) ||
        response.size <= 0 || response.size > maximumBytes ||
        typeof response.content !== 'string') {
        throw invalid();
    }
    const encoded = response.content.replaceAll('\n', '');
    if (!BASE64.test(encoded)) throw invalid();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== response.size || bytes.length > maximumBytes ||
        bytes.toString('base64') !== encoded) {
        throw invalid();
    }
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        throw invalid();
    }
}

function validateRef(value, expectedRef, mergeCommit) {
    if (value?.ref !== expectedRef || value?.object?.type !== 'commit' ||
        value.object.sha !== mergeCommit) {
        throw invalid();
    }
}

function validateConfiguration(value) {
    if (!exactKeys(value, CONFIGURATION_KEYS) || value.schemaVersion !== 2 ||
        value.managedBy !== '@kyaulabs/prism-core' || value.versionPolicy !== 'lockstep' ||
        !Array.isArray(value.packages) || value.packages.length === 0 ||
        !Array.isArray(value.adapterReleases) || value.adapterReleases.length === 0 ||
        value.adapterReleases.length > 64) {
        throw invalid();
    }
    const packages = new Set();
    for (const packagePath of value.packages) {
        if (typeof packagePath !== 'string' || !PACKAGE_PATH.test(packagePath) ||
            packagePath.split('/').some((part) => part === '.' || part === '..') ||
            packages.has(packagePath)) {
            throw invalid();
        }
        packages.add(packagePath);
    }
    const declaredPackages = new Set();
    const identifiers = new Set();
    for (const declaration of value.adapterReleases) {
        if (!exactKeys(declaration, DECLARATION_KEYS) ||
            !packages.has(declaration.package) ||
            declaredPackages.has(declaration.package) ||
            typeof declaration.id !== 'string' || identifiers.has(declaration.id)) {
            throw invalid();
        }
        declaredPackages.add(declaration.package);
        identifiers.add(declaration.id);
    }
    return value.adapterReleases;
}

async function resolveAdapter({declaration, version, mergeCommit, fetchImpl}) {
    const manifestPath = `${declaration.package}/package.json`;
    const manifestResponse = await githubRequest(
        `/contents/${manifestPath}?ref=${mergeCommit}`,
        fetchImpl,
    );
    const manifest = contentJson(manifestResponse, manifestPath, MAX_MANIFEST_BYTES);
    if (manifest?.private === true || manifest?.publishConfig?.access !== 'public' ||
        typeof manifest?.name !== 'string' || manifest.version !== version ||
        manifest?.prism?.adapter !== true ||
        manifest.prism.bootstrapProtocol !== declaration.bootstrapProtocol) {
        throw invalid();
    }
    const separator = manifest.name.indexOf('/');
    if (!PACKAGE_NAME.test(manifest.name) || separator < 0 ||
        separator === manifest.name.length - 1) {
        throw invalid();
    }
    const tagPrefix = manifest.name.slice(separator + 1);
    const tagName = `${tagPrefix}@${version}`;
    const packageRef = await githubRequest(`/git/ref/tags/${tagName}`, fetchImpl);
    validateRef(packageRef, `refs/tags/${tagName}`, mergeCommit);
    return {
        id: declaration.id,
        displayName: declaration.displayName,
        packageName: manifest.name,
        releases: [{
            version,
            coreRange: declaration.coreRange,
            bootstrapProtocol: declaration.bootstrapProtocol,
            status: declaration.status,
        }],
    };
}

async function resolveEvidence({version, mergeCommit, fetchImpl}) {
    if (typeof version !== 'string' || !VERSION.test(version) ||
        typeof mergeCommit !== 'string' || !COMMIT.test(mergeCommit)) {
        throw invalid();
    }
    const releaseTag = `v${version}`;
    const release = await githubRequest(`/releases/tags/${releaseTag}`, fetchImpl);
    if (release?.tag_name !== releaseTag || release.target_commitish !== mergeCommit ||
        release.draft !== false || release.prerelease !== false) {
        throw invalid();
    }
    const releaseRef = await githubRequest(`/git/ref/tags/${releaseTag}`, fetchImpl);
    validateRef(releaseRef, `refs/tags/${releaseTag}`, mergeCommit);
    const commit = await githubRequest(`/commits/${mergeCommit}`, fetchImpl);
    if (commit?.sha !== mergeCommit || !Array.isArray(commit.parents) ||
        commit.parents.length !== 2 ||
        commit.parents.some((parent) => typeof parent?.sha !== 'string' ||
            !COMMIT.test(parent.sha))) {
        throw invalid();
    }
    const configurationPath = '.prism/release.json';
    const configurationResponse = await githubRequest(
        `/contents/${configurationPath}?ref=${mergeCommit}`,
        fetchImpl,
    );
    const configuration = contentJson(
        configurationResponse,
        configurationPath,
        MAX_CONFIGURATION_BYTES,
    );
    const declarations = validateConfiguration(configuration);
    const adapters = [];
    for (const declaration of declarations) {
        adapters.push(await resolveAdapter({
            declaration,
            version,
            mergeCommit,
            fetchImpl,
        }));
    }
    const source = readCatalogueSource({schemaVersion: 1, adapters});
    return Object.freeze({
        repository: REPOSITORY,
        version,
        mergeCommit,
        adapters: source.adapters,
    });
}

export async function resolvePrismReleaseEvidence({
    version,
    mergeCommit,
    fetchImpl = globalThis.fetch,
}) {
    try {
        return await resolveEvidence({version, mergeCommit, fetchImpl});
    } catch (error) {
        if (error instanceof EvidenceUnavailableError || error instanceof EvidenceInvalidError) {
            throw error;
        }
        throw invalid();
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
