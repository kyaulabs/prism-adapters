// $KYAULabs: npm-evidence.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

import {setTimeout as sleep} from 'node:timers/promises';

import {
    EvidenceInvalidError,
    EvidenceUnavailableError,
    requestBoundedJson,
} from './evidence-http.js';

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PACKAGE_NAME = /^@kyaulabs\/[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const UTC_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function invalid() {
    return new EvidenceInvalidError('npm release evidence is invalid');
}

function canonicalIntegrity(value) {
    if (typeof value !== 'string' || !INTEGRITY.test(value)) return false;
    const encoded = value.slice('sha512-'.length);
    const digest = Buffer.from(encoded, 'base64');
    return digest.length === 64 && digest.toString('base64') === encoded;
}

function normalizeEvidence(packument, version) {
    const release = packument?.versions?.[version];
    const integrity = release?.dist?.integrity;
    const rawPublishedAt = packument?.time?.[version];
    const publishedAt = new Date(rawPublishedAt);
    if (!canonicalIntegrity(integrity) || typeof rawPublishedAt !== 'string' ||
        !UTC_TIMESTAMP.test(rawPublishedAt) || !Number.isFinite(publishedAt.getTime()) ||
        publishedAt.toISOString() !== rawPublishedAt) {
        throw invalid();
    }
    return Object.freeze({
        integrity,
        publishedAt: publishedAt.toISOString(),
    });
}

export async function resolveNpmReleaseEvidence({
    packageName,
    version,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
}) {
    if (typeof packageName !== 'string' || !PACKAGE_NAME.test(packageName) ||
        typeof version !== 'string' || !VERSION.test(version)) {
        throw invalid();
    }
    const url = `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const packument = await requestBoundedJson({
                url,
                fetchImpl,
                maximumBytes: MAX_REGISTRY_BYTES,
                errorMessage: 'npm release evidence',
                headers: {
                    accept: 'application/json',
                    'user-agent': '@kyaulabs/prism-adapters-catalogue',
                },
            });
            return normalizeEvidence(packument, version);
        } catch (error) {
            if (!(error instanceof EvidenceUnavailableError) || attempt === MAX_ATTEMPTS) {
                throw error;
            }
            await sleepImpl(RETRY_DELAY_MS);
        }
    }
    throw new EvidenceUnavailableError('npm release evidence is unavailable');
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
