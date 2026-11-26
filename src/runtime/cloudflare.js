import { CloudflareKVAdapter } from '../adapters/kv/cloudflareKv.js';

function parseOptionalNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createCloudflareRuntime(env) {
    return {
        kv: env?.SUBLINK_KV ? new CloudflareKVAdapter(env.SUBLINK_KV) : null,
        assetFetcher: env?.ASSETS ? (request) => env.ASSETS.fetch(request) : null,
        logger: console,
        hub: {
            db: env?.HUB_DB,
            adminPasswordHash: env?.ADMIN_PASSWORD_HASH,
            dataEncryptionKey: env?.DATA_ENCRYPTION_KEY,
            authRequired: env?.HUB_AUTH_REQUIRED === 'true' || env?.HUB_AUTH_REQUIRED === true,
            cacheTtlSeconds: parseOptionalNumber(env?.HUB_CACHE_TTL_SECONDS),
            maxStaleSeconds: parseOptionalNumber(env?.HUB_MAX_STALE_SECONDS),
            ...(env?.HUB_FETCH_IMPL ? { fetchImpl: env.HUB_FETCH_IMPL } : {})
        },
        config: {}
    };
}
