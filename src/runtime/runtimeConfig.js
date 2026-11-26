/**
 * @typedef {Object} KeyValueStore
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 */

/**
 * @typedef {(request: Request) => Promise<Response>} AssetFetcher
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {number} [configTtlSeconds]
 * @property {number} [shortLinkTtlSeconds]
 */

/**
 * @typedef {Object} RuntimeBindings
 * @property {KeyValueStore | null} [kv]
 * @property {AssetFetcher | null} [assetFetcher]
 * @property {Console} [logger]
 * @property {RuntimeConfig} [config]
 * @property {{ db?: object | null, repo?: object | null, adminPasswordHash?: string | null, dataEncryptionKey?: string | null, authRequired?: boolean, cacheTtlSeconds?: number, maxStaleSeconds?: number, fetchImpl?: Function }} [hub]
 */

const DEFAULTS = {
    configTtlSeconds: 60 * 60 * 24 * 30,
    hubCacheTtlSeconds: 60 * 60 * 6,
    hubMaxStaleSeconds: 60 * 60 * 24 * 7
};

/**
 * Normalize optional runtime bindings and provide safe defaults.
 *
 * @param {RuntimeBindings | undefined} runtime
 * @returns {{ kv: KeyValueStore | null, assetFetcher: AssetFetcher | null, logger: Console, config: RuntimeConfig & { configTtlSeconds: number, shortLinkTtlSeconds: number | null }, hub: NonNullable<RuntimeBindings['hub']> }}
 */
export function normalizeRuntime(runtime = {}) {
    return {
        kv: runtime.kv ?? null,
        assetFetcher: runtime.assetFetcher ?? null,
        logger: runtime.logger ?? console,
        hub: {
            db: runtime.hub?.db ?? null,
            repo: runtime.hub?.repo ?? null,
            adminPasswordHash: runtime.hub?.adminPasswordHash ?? null,
            dataEncryptionKey: runtime.hub?.dataEncryptionKey ?? null,
            authRequired: Boolean(runtime.hub?.authRequired),
            cacheTtlSeconds: runtime.hub?.cacheTtlSeconds ?? DEFAULTS.hubCacheTtlSeconds,
            maxStaleSeconds: runtime.hub?.maxStaleSeconds ?? DEFAULTS.hubMaxStaleSeconds,
            fetchImpl: runtime.hub?.fetchImpl
        },
        config: {
            configTtlSeconds: runtime.config?.configTtlSeconds ?? DEFAULTS.configTtlSeconds,
            shortLinkTtlSeconds: runtime.config?.shortLinkTtlSeconds ?? null
        }
    };
}
