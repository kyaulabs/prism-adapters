// $KYAULabs: catalogue-source.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CORE_RANGE = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) <(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PACKAGE_NAME = /^@kyaulabs\/[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?$/;

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

function compareVersions(left, right) {
    const leftParts = left.split('.').map(BigInt);
    const rightParts = right.split('.').map(BigInt);
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] < rightParts[index]) return -1;
        if (leftParts[index] > rightParts[index]) return 1;
    }
    return 0;
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

export function sourceFromVerifiedCatalogue(catalogue) {
    return readCatalogueSource({
        schemaVersion: 1,
        adapters: catalogue.adapters.map((adapter) => ({
            id: adapter.id,
            displayName: adapter.displayName,
            packageName: adapter.packageName,
            releases: adapter.releases.map((release) => ({
                version: release.version,
                coreRange: release.coreRange,
                bootstrapProtocol: release.bootstrapProtocol,
                status: release.status,
            })).sort((left, right) => compareVersions(left.version, right.version)),
        })).sort((left, right) => left.id.localeCompare(right.id)),
    });
}

export function renderCatalogueSource(source) {
    const validated = readCatalogueSource(source);
    return `${JSON.stringify(validated, null, 2)}\n`;
}

export function applyReleaseEvidence({current, evidence}) {
    const source = structuredClone(sourceFromVerifiedCatalogue(current));
    const adapters = new Map(source.adapters.map((adapter) => [adapter.id, adapter]));
    for (const incoming of evidence.adapters) {
        const existing = adapters.get(incoming.id);
        if (existing === undefined) {
            const added = structuredClone(incoming);
            added.releases.sort((left, right) => compareVersions(left.version, right.version));
            adapters.set(incoming.id, added);
            continue;
        }
        if (existing.packageName !== incoming.packageName ||
            existing.displayName !== incoming.displayName) {
            throw new Error('release evidence conflicts with the verified catalogue');
        }
        const releases = new Map(existing.releases.map((release) => [release.version, release]));
        for (const release of incoming.releases) releases.set(release.version, {...release});
        existing.releases = [...releases.values()].sort((left, right) =>
            compareVersions(left.version, right.version));
    }
    source.adapters = [...adapters.values()].sort((left, right) => left.id.localeCompare(right.id));
    return readCatalogueSource(source);
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
