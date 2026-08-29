// $KYAULabs: payload.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {readCatalogueSource} from './catalogue-source.js';
import {resolveNpmReleaseEvidence} from './npm-evidence.js';
import {CATALOGUE_ID} from './public-key.js';

export {readCatalogueSource};

const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const UTC_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function exactKeys(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
        actual.every((key, index) => key === expected[index]);
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

export async function hydrateCatalogue({
    source,
    sequence,
    now = new Date(),
    npmEvidence,
    fetchImpl = globalThis.fetch,
}) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('catalogue sequence is invalid');
    }
    const evidenceBoundary = typeof npmEvidence === 'function'
        ? npmEvidence
        : (request) => resolveNpmReleaseEvidence({...request, fetchImpl});
    const current = new Date(now);
    if (!Number.isFinite(current.getTime())) throw new Error('catalogue clock is invalid');
    const adapters = [];
    for (const adapter of source.adapters) {
        const releases = [];
        for (const release of adapter.releases) {
            const metadata = await evidenceBoundary({
                packageName: adapter.packageName,
                version: release.version,
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
