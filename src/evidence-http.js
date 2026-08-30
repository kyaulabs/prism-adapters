// $KYAULabs: evidence-http.js kyau@aura.kyaulabs 2026/08/28 -0700 Exp $

export class EvidenceUnavailableError extends Error {}
export class EvidenceInvalidError extends Error {}

function invalid(errorMessage) {
    return new EvidenceInvalidError(`${errorMessage} is invalid`);
}

function unavailable(errorMessage) {
    return new EvidenceUnavailableError(`${errorMessage} is unavailable`);
}

async function responseBytes(response, maximumBytes, errorMessage) {
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined &&
        (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
        throw invalid(errorMessage);
    }
    let bytes;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                const chunk = Buffer.from(value);
                length += chunk.length;
                if (length > maximumBytes) {
                    await reader.cancel().catch(() => {});
                    throw invalid(errorMessage);
                }
                chunks.push(chunk);
            }
        } catch (error) {
            if (error instanceof EvidenceInvalidError) throw error;
            throw unavailable(errorMessage);
        }
        bytes = Buffer.concat(chunks, length);
    } else {
        try {
            bytes = Buffer.from(await response.arrayBuffer());
        } catch {
            throw unavailable(errorMessage);
        }
    }
    if (bytes.length === 0 || bytes.length > maximumBytes) throw invalid(errorMessage);
    return bytes;
}

export async function requestBoundedJson({
    url,
    fetchImpl,
    maximumBytes,
    timeoutMs = 10_000,
    errorMessage,
    headers = {},
    unavailableStatuses = [404, 408, 425, 429],
}) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw unavailable(errorMessage);
    }
    if (response?.redirected === true || (response?.status >= 300 && response.status < 400)) {
        throw invalid(errorMessage);
    }
    if (unavailableStatuses.includes(response?.status) || response?.status >= 500) {
        throw unavailable(errorMessage);
    }
    if (response?.status !== 200) throw invalid(errorMessage);
    const bytes = await responseBytes(response, maximumBytes, errorMessage);
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        throw invalid(errorMessage);
    }
}

// vim: ft=javascript sts=4 sw=4 ts=4 et :
