// $KYAULabs: payload.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {CATALOGUE_ID} from './public-key.js';

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CORE_RANGE = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PACKAGE_NAME = /^@kyaulabs\/[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const UTC_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
}

function boundedString(value, maximum) {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
        value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalIntegrity(value) {
    if (typeof value !== 'string' || !INTEGRITY.test(value)) return false;
    const encoded = value.slice('sha512-'.length);
    const digest = Buffer.from(encoded, 'base64');
    return digest.length === 64 && digest.toString('base64') === encoded;
}

function timestamp(value) {
    if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) {
        throw new Error('catalogue timestamp is invalid');
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error('catalogue timestamp is invalid');
    }
    return parsed;
}

function validCoreRange(value) {
    const match = typeof value === 'string' ? CORE_RANGE.exec(value) : null;
    if (match === null) return false;
    const lower = match.slice(1, 4).map(BigInt);
    const upper = match.slice(4, 7).map(BigInt);
    for (let index = 0; index < lower.length; index += 1) {
        if (lower[index] < upper[index]) return true;
        if (lower[index] > upper[index]) return false;
    }
    return false;
}

function validateSourceRelease(value) {
    if (!exactKeys(value, [
        'version', 'coreRange', 'bootstrapProtocol', 'status',
    ]) || !VERSION.test(value.version) || !validCoreRange(value.coreRange) ||
        !Number.isSafeInteger(value.bootstrapProtocol) || value.bootstrapProtocol <= 0 ||
        !['ACTIVE', 'REVOKED'].includes(value.status)) {
        throw new Error('catalogue source is invalid');
    }
    return Object.freeze({...value});
}

export function readCatalogueSource(value) {
    if (!exactKeys(value, ['schemaVersion', 'adapters']) || value.schemaVersion !== 1 ||
        !Array.isArray(value.adapters) || value.adapters.length === 0 ||
        value.adapters.length > 64) {
        throw new Error('catalogue source is invalid');
    }
    const ids = new Set();
    const packages = new Set();
    const adapters = value.adapters.map((adapter) => {
        if (!exactKeys(adapter, ['id', 'displayName', 'packageName', 'releases']) ||
            !ADAPTER_ID.test(adapter.id) || ids.has(adapter.id) ||
            !boundedString(adapter.displayName, 120) ||
            !PACKAGE_NAME.test(adapter.packageName) || packages.has(adapter.packageName) ||
            !Array.isArray(adapter.releases) || adapter.releases.length === 0 ||
            adapter.releases.length > 256) {
            throw new Error('catalogue source is invalid');
        }
        const versions = new Set();
        const releases = adapter.releases.map((release) => {
            const validated = validateSourceRelease(release);
            if (versions.has(validated.version)) throw new Error('catalogue source is invalid');
            versions.add(validated.version);
            return validated;
        });
        ids.add(adapter.id);
        packages.add(adapter.packageName);
        return Object.freeze({...adapter, releases: Object.freeze(releases)});
    });
    return Object.freeze({schemaVersion: 1, adapters: Object.freeze(adapters)});
}

async function responseBytes(response) {
    if (!response || response.status !== 200 || response.redirected === true) {
        throw new Error('npm release metadata is unavailable');
    }
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > MAX_REGISTRY_BYTES)) {
        throw new Error('npm release metadata is invalid');
    }
    let bytes;
    try {
        bytes = Buffer.from(await response.arrayBuffer());
    } catch {
        throw new Error('npm release metadata is unavailable');
    }
    if (bytes.length === 0 || bytes.length > MAX_REGISTRY_BYTES) {
        throw new Error('npm release metadata is invalid');
    }
    return bytes;
}

async function fetchPackageMetadata({packageName, version, fetchImpl}) {
    const url = `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}`;
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers: {
                accept: 'application/json',
                'user-agent': '@kyaulabs/prism-adapters-catalogue',
            },
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new Error('npm release metadata is unavailable');
    }
    const bytes = await responseBytes(response);
    let packument;
    try {
        packument = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('npm release metadata is invalid');
    }
    const integrity = packument?.versions?.[version]?.dist?.integrity;
    const rawPublishedAt = packument?.time?.[version];
    const parsedPublishedAt = new Date(rawPublishedAt);
    if (!canonicalIntegrity(integrity) || !Number.isFinite(parsedPublishedAt.getTime())) {
        throw new Error('npm release metadata is invalid');
    }
    return Object.freeze({
        integrity,
        publishedAt: parsedPublishedAt.toISOString(),
    });
}

export function validateCataloguePayload({
    value,
    now = new Date(),
    allowExpired = false,
}) {
    if (!exactKeys(value, [
        'schemaVersion', 'catalogueId', 'sequence', 'issuedAt', 'expiresAt', 'adapters',
    ]) || value.schemaVersion !== 1 || value.catalogueId !== CATALOGUE_ID ||
        !Number.isSafeInteger(value.sequence) || value.sequence <= 0 ||
        !Array.isArray(value.adapters) || value.adapters.length === 0 ||
        value.adapters.length > 64) {
        throw new Error('catalogue payload is invalid');
    }
    const issuedAt = timestamp(value.issuedAt);
    const expiresAt = timestamp(value.expiresAt);
    const current = new Date(now);
    if (!Number.isFinite(current.getTime())) throw new Error('catalogue clock is invalid');
    if (issuedAt.getTime() > current.getTime() + FIVE_MINUTES) {
        throw new Error('catalogue is not yet valid');
    }
    if (expiresAt.getTime() <= issuedAt.getTime() ||
        expiresAt.getTime() - issuedAt.getTime() > SEVEN_DAYS) {
        throw new Error('catalogue payload is invalid');
    }
    if (!allowExpired && expiresAt.getTime() <= current.getTime()) {
        throw new Error('catalogue is expired');
    }
    readCatalogueSource({
        schemaVersion: 1,
        adapters: value.adapters.map((adapter) => ({
            id: adapter.id,
            displayName: adapter.displayName,
            packageName: adapter.packageName,
            releases: adapter.releases.map((release) => ({
                version: release.version,
                coreRange: release.coreRange,
                bootstrapProtocol: release.bootstrapProtocol,
                status: release.status,
            })),
        })),
    });
    for (const adapter of value.adapters) {
        if (!exactKeys(adapter, ['id', 'displayName', 'packageName', 'releases'])) {
            throw new Error('catalogue payload is invalid');
        }
        for (const release of adapter.releases) {
            if (!exactKeys(release, [
                'version', 'coreRange', 'bootstrapProtocol', 'integrity',
                'publishedAt', 'status',
            ]) || !canonicalIntegrity(release.integrity)) {
                throw new Error('catalogue payload is invalid');
            }
            timestamp(release.publishedAt);
        }
    }
    return Object.freeze(value);
}

export async function hydrateCatalogue({source, sequence, now = new Date(), fetchImpl = fetch}) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('catalogue sequence is invalid');
    }
    const current = new Date(now);
    if (!Number.isFinite(current.getTime())) throw new Error('catalogue clock is invalid');
    const adapters = [];
    for (const adapter of source.adapters) {
        const releases = [];
        for (const release of adapter.releases) {
            const metadata = await fetchPackageMetadata({
                packageName: adapter.packageName,
                version: release.version,
                fetchImpl,
            });
            releases.push({...release, ...metadata});
        }
        adapters.push({...adapter, releases});
    }
    const payload = {
        schemaVersion: 1,
        catalogueId: CATALOGUE_ID,
        sequence,
        issuedAt: current.toISOString(),
        expiresAt: new Date(current.getTime() + SIX_DAYS).toISOString(),
        adapters,
    };
    return validateCataloguePayload({value: payload, now: current});
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
