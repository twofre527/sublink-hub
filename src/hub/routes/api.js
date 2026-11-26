import { InvalidPayloadError, ServiceError } from '../../services/errors.js';
import { normalizeTarget } from '../converter/formatOutput.js';
import { parseSubscriptionPayload, safeFetchSubscription, validateUpstreamUrl } from '../converter/fetchAndParse.js';
import { mergeSourceNodes } from '../converter/mergeNodes.js';

const inputFormats = new Set(['auto', 'yaml', 'base64', 'uri', 'json', 'surge']);
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const sharedInFlight = new WeakMap();
const errorJson = (c, status, code, message, extra = {}) => c.json({ error: { code, message }, ...extra }, status);
const notFound = (c, resource) => errorJson(c, 404, 'NOT_FOUND', resource + ' not found');

export function maskSubscriptionUrl(rawUrl) {
    try {
        return 'https://' + new URL(rawUrl).host + '/•••';
    } catch {
        return '•••';
    }
}

export function sanitizeNodePreview(node) {
    return {
        tag: node.tag ?? node.name ?? '', type: node.type, server: node.server, port: node.server_port,
        tls: Boolean(node.tls?.enabled), transport: node.transport?.type || 'tcp'
    };
}

export function createSourceRefresher({ repo, fetchImpl, inFlightKey = repo }) {
    let inFlight = inFlightKey && typeof inFlightKey === 'object' ? sharedInFlight.get(inFlightKey) : null;
    if (!inFlight) {
        inFlight = new Map();
        if (inFlightKey && typeof inFlightKey === 'object') sharedInFlight.set(inFlightKey, inFlight);
    }

    async function refresh(sourceId, now) {
        const source = await repo.getSource(sourceId);
        if (!source) return { ok: false, notFound: true };

        const fail = async error => {
            const updated = await repo.saveSourceRefreshFailure(sourceId, {
                error, attemptedAt: now, expectedVersion: source.cacheVersion
            });
            return { ok: false, error, source: updated ?? await repo.getSource(sourceId) };
        };

        let fetched;
        try {
            fetched = await safeFetchSubscription(source.url, { userAgent: source.requestUA || 'clash.meta', fetchImpl });
        } catch (error) {
            // The fetcher limits diagnostics to validation, host and status details.
            return fail(error.message);
        }

        let parsed;
        try {
            parsed = await parseSubscriptionPayload(fetched.text, { inputFormat: source.inputFormat || 'auto' });
        } catch (error) {
            return fail(error instanceof InvalidPayloadError ? error.message : 'Failed to parse upstream subscription');
        }
        const { nodes, droppedCount, diagnostics } = parsed;
        if (!nodes.length) return fail(diagnostics[0] ?? 'Upstream returned 0 valid proxy nodes');

        const saved = await repo.saveSourceRefreshSuccess(sourceId, {
            nodes, droppedCount, diagnostics, attemptedAt: now, expectedVersion: source.cacheVersion
        });
        if (saved.conflict) return { ok: true, source: await repo.getSource(sourceId), conflict: true };
        if (!saved.updated) return { ok: false, notFound: true };
        return { ok: true, source: saved.source };
    }

    return {
        refreshSource(sourceId, { now = Date.now() } = {}) {
            if (!inFlight.has(sourceId)) {
                const pending = refresh(sourceId, now).finally(() => {
                    if (inFlight.get(sourceId) === pending) inFlight.delete(sourceId);
                });
                inFlight.set(sourceId, pending);
            }
            return inFlight.get(sourceId);
        },
        invalidate(sourceId) {
            inFlight.delete(sourceId);
        }
    };
}

export function createRefresherResolver(refresher) {
    const byRepo = new WeakMap();
    return ({ repo, config }) => {
        if (refresher) return refresher;
        if (!byRepo.has(repo)) {
            byRepo.set(repo, createSourceRefresher({ repo, fetchImpl: config?.fetchImpl, inFlightKey: config?.db ?? repo }));
        }
        return byRepo.get(repo);
    };
}

function formatSourceResponse(source) {
    const {
        id, alias, url, inputFormat, requestUA, enabled, nodeCount, droppedCount, diagnostics,
        status, lastError, lastAttemptAt, lastSuccessAt, cacheVersion, createdAt, updatedAt
    } = source;
    return {
        id, alias, maskedUrl: maskSubscriptionUrl(url), inputFormat, requestUA, enabled, nodeCount,
        droppedCount, diagnostics, status, lastError, lastAttemptAt, lastSuccessAt, cacheVersion, createdAt, updatedAt
    };
}

async function readBody(c) {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidPayloadError('Invalid JSON body');
    return body;
}

function readString(value, field, max, required = false) {
    if (typeof value !== 'string') throw new InvalidPayloadError(field + ' must be a string');
    const trimmed = value.trim();
    if ((required && !trimmed) || trimmed.length > max) throw new InvalidPayloadError('Invalid ' + field);
    return trimmed;
}

function readBooleans(body, fields) {
    const patch = {};
    for (const field of fields) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'boolean') throw new InvalidPayloadError(field + ' must be a boolean');
        patch[field] = body[field];
    }
    return patch;
}

function readSourceFields(body, creating) {
    const patch = {
        ...(creating ? { inputFormat: 'auto', requestUA: 'clash.meta', enabled: true } : {}),
        ...readBooleans(body, ['enabled'])
    };
    if (creating || body.alias !== undefined) patch.alias = readString(body.alias, 'alias', 80, true);
    if (creating || (body.url !== undefined && body.url !== '')) {
        if (typeof body.url !== 'string') throw new InvalidPayloadError('Invalid upstream URL');
        patch.url = validateUpstreamUrl(body.url).href;
    }
    if (body.inputFormat !== undefined) {
        if (!inputFormats.has(body.inputFormat)) throw new InvalidPayloadError('Unsupported input format');
        patch.inputFormat = body.inputFormat;
    }
    if (body.requestUA !== undefined) {
        const ua = readString(body.requestUA, 'requestUA', 200);
        if (!ASCII_PRINTABLE.test(ua)) throw new InvalidPayloadError('Invalid requestUA');
        patch.requestUA = ua || 'clash.meta';
    }
    return patch;
}

function readCollectionFields(body, sourcesById, creating) {
    const patch = {
        ...(creating ? { prefixEnabled: true, deduplicate: true, defaultTarget: 'mihomo', enabled: true } : {}),
        ...readBooleans(body, ['prefixEnabled', 'deduplicate', 'enabled'])
    };
    if (creating || body.alias !== undefined) patch.alias = readString(body.alias, 'alias', 80, true);
    if (creating || body.sourceIds !== undefined) {
        const ids = body.sourceIds;
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length ||
            ids.some(id => typeof id !== 'string' || !sourcesById.has(id))) {
            throw new InvalidPayloadError('sourceIds must contain unique, existing source IDs');
        }
        patch.sourceIds = ids;
    }
    if (body.defaultTarget !== undefined) patch.defaultTarget = normalizeTarget(body.defaultTarget) ?? 'mihomo';
    if (body.cacheTtlHours !== undefined) {
        if (body.cacheTtlHours === null || body.cacheTtlHours === '') {
            patch.cacheTtlHours = null;
        } else if (typeof body.cacheTtlHours !== 'number' || !Number.isInteger(body.cacheTtlHours) ||
            body.cacheTtlHours < 0 || body.cacheTtlHours > 168) {
            throw new InvalidPayloadError('cacheTtlHours must be an integer between 0 and 168');
        } else {
            patch.cacheTtlHours = body.cacheTtlHours;
        }
    }
    return patch;
}

function mergeCollection(collection, sourcesById, { maxStaleMs, now }) {
    const entries = [];
    const warnings = [];
    for (const id of collection.sourceIds) {
        const source = sourcesById.get(id);
        if (!source) {
            warnings.push(`Source ${id} is missing`);
            continue;
        }
        if (!source.enabled) {
            warnings.push(`Source ${source.alias} is disabled`);
            continue;
        }
        if (source.status === 'error') warnings.push(`Source ${source.alias} refresh failed: ${source.lastError}`);
        if (!source.nodes.length) continue;
        if (source.lastSuccessAt === null || now - source.lastSuccessAt > maxStaleMs) {
            warnings.push(`Source ${source.alias} cache is stale`);
            continue;
        }
        entries.push({ sourceId: id, alias: source.alias, nodes: source.nodes });
    }
    return { ...mergeSourceNodes(entries, collection), warnings };
}

function computeCollectionView(collection, sourcesById, cache) {
    const { nodes, warnings } = mergeCollection(collection, sourcesById, cache);
    const {
        id, alias, sourceIds, prefixEnabled, deduplicate, defaultTarget, cacheTtlHours,
        enabled, tokenVersion, token, createdAt, updatedAt
    } = collection;
    return {
        id, alias, sourceIds, prefixEnabled, deduplicate, defaultTarget, cacheTtlHours: cacheTtlHours ?? null,
        enabled, tokenVersion,
        subscriptionPath: '/sub/' + token, mergedNodeCount: nodes.length, warnings, createdAt, updatedAt
    };
}

const loadSourcesById = async repo => new Map((await repo.listSources()).map(source => [source.id, source]));
const collectionCache = config => ({ maxStaleMs: (config?.maxStaleSeconds ?? 604800) * 1000, now: Date.now() });

export function mountHubApiRoutes(app, { refresher } = {}) {
    const getRefresher = createRefresherResolver(refresher);
    const route = handler => async c => {
        try {
            return await handler(c, c.get('hub'));
        } catch (error) {
            if (error instanceof ServiceError && error.status === 400) {
                return errorJson(c, 400, 'INVALID_PAYLOAD', error.message);
            }
            throw error;
        }
    };

    app.get('/api/hub/sources', route(async (c, { repo }) =>
        c.json({ sources: (await repo.listSources()).map(formatSourceResponse) })
    ));

    app.post('/api/hub/sources', route(async (c, hub) => {
        const fields = readSourceFields(await readBody(c), true);
        const created = await hub.repo.createSource(fields);
        const result = await getRefresher(hub).refreshSource(created.id);
        return c.json({ source: formatSourceResponse(result.source ?? created) }, 201);
    }));

    app.get('/api/hub/sources/:id', route(async (c, { repo }) => {
        const source = await repo.getSource(c.req.param('id'));
        return source ? c.json({ source: formatSourceResponse(source) }) : notFound(c, 'Source');
    }));

    app.put('/api/hub/sources/:id', route(async (c, hub) => {
        const id = c.req.param('id');
        if (!await hub.repo.getSource(id)) return notFound(c, 'Source');
        const fields = readSourceFields(await readBody(c), false);
        if (fields.url !== undefined || fields.inputFormat !== undefined || fields.requestUA !== undefined) {
            getRefresher(hub).invalidate?.(id);
        }
        const source = await hub.repo.updateSource(id, fields);
        return source ? c.json({ source: formatSourceResponse(source) }) : notFound(c, 'Source');
    }));

    app.delete('/api/hub/sources/:id', route(async (c, { repo }) => {
        const { referencedBy, notFound: missing } = await repo.deleteSource(c.req.param('id'));
        if (referencedBy) {
            return errorJson(c, 409, 'SOURCE_IN_USE', 'Source is referenced by one or more collections', { collections: referencedBy });
        }
        return missing ? notFound(c, 'Source') : c.json({ ok: true });
    }));

    app.post('/api/hub/sources/:id/refresh', route(async (c, hub) => {
        const result = await getRefresher(hub).refreshSource(c.req.param('id'));
        if (result.notFound || !result.source) return notFound(c, 'Source');
        const source = formatSourceResponse(result.source);
        if (result.ok) return c.json({ ok: true, source });
        if (result.source.nodes.length) return c.json({ ok: false, staleRetained: true, warning: result.error, source });
        return errorJson(c, 502, 'UPSTREAM_FAILED', result.error, { source });
    }));

    app.get('/api/hub/sources/:id/nodes', route(async (c, { repo }) => {
        const source = await repo.getSource(c.req.param('id'));
        if (!source) return notFound(c, 'Source');
        const { id, alias, nodeCount, droppedCount, diagnostics, nodes } = source;
        return c.json({ sourceId: id, alias, nodeCount, droppedCount, diagnostics, nodes: nodes.map(sanitizeNodePreview) });
    }));

    app.get('/api/hub/collections', route(async (c, { repo, config }) => {
        const [collections, sources] = await Promise.all([repo.listCollections(), loadSourcesById(repo)]);
        const cache = collectionCache(config);
        return c.json({ collections: collections.map(collection => computeCollectionView(collection, sources, cache)) });
    }));

    app.post('/api/hub/collections', route(async (c, { repo, config }) => {
        const body = await readBody(c);
        const sources = await loadSourcesById(repo);
        const collection = await repo.createCollection(readCollectionFields(body, sources, true));
        return c.json({ collection: computeCollectionView(collection, sources, collectionCache(config)) }, 201);
    }));

    const collectionResponse = async (c, collection, { repo, config }) => collection
        ? c.json({ collection: computeCollectionView(collection, await loadSourcesById(repo), collectionCache(config)) })
        : notFound(c, 'Collection');

    app.get('/api/hub/collections/:id', route(async (c, hub) =>
        collectionResponse(c, await hub.repo.getCollection(c.req.param('id')), hub)
    ));

    app.put('/api/hub/collections/:id', route(async (c, { repo, config }) => {
        const id = c.req.param('id');
        if (!await repo.getCollection(id)) return notFound(c, 'Collection');
        const body = await readBody(c);
        const sources = await loadSourcesById(repo);
        const collection = await repo.updateCollection(id, readCollectionFields(body, sources, false));
        return collection
            ? c.json({ collection: computeCollectionView(collection, sources, collectionCache(config)) })
            : notFound(c, 'Collection');
    }));

    app.delete('/api/hub/collections/:id', route(async (c, { repo }) =>
        await repo.deleteCollection(c.req.param('id')) ? c.json({ ok: true }) : notFound(c, 'Collection')
    ));

    app.get('/api/hub/collections/:id/nodes', route(async (c, { repo, config }) => {
        const collection = await repo.getCollection(c.req.param('id'));
        if (!collection) return notFound(c, 'Collection');
        const { nodes, warnings, totalBeforeDedup, dedupedCount } =
            mergeCollection(collection, await loadSourcesById(repo), collectionCache(config));
        return c.json({
            collectionId: collection.id, alias: collection.alias, totalBeforeDedup, dedupedCount,
            nodeCount: nodes.length, warnings, nodes: nodes.map(sanitizeNodePreview)
        });
    }));

    app.post('/api/hub/collections/:id/rotate-token', route(async (c, hub) => {
        const id = c.req.param('id');
        if (!await hub.repo.getCollection(id)) return notFound(c, 'Collection');
        return collectionResponse(c, await hub.repo.rotateCollectionToken(id), hub);
    }));
}
