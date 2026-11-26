import { InvalidConfigError, InvalidPayloadError } from '../../services/errors.js';
import { formatSubscriptionOutput, resolveOutputTarget } from '../converter/formatOutput.js';
import { mergeSourceNodes } from '../converter/mergeNodes.js';
import { sha256Hex } from '../crypto.js';
import { createRefresherResolver } from './api.js';

const toEntry = ({ id, alias, nodes }) => ({ sourceId: id, alias, nodes });

export function mountSubRoutes(app, { refresher } = {}) {
    const getRefresher = createRefresherResolver(refresher);

    app.get('/sub/:token', async c => {
        c.header('Cache-Control', 'private, no-store');
        c.header('Vary', 'User-Agent');
        c.header('Referrer-Policy', 'no-referrer');
        c.header('X-Content-Type-Options', 'nosniff');
        const textError = (status, message) => c.text(message, status);

        const hub = c.get('hub');
        const { repo, config } = hub;
        if (!repo) return textError(503, 'Service unavailable');

        const collection = await repo.getCollectionByTokenHash(await sha256Hex(c.req.param('token')));
        if (!collection?.enabled) return textError(404, 'Not Found');

        const explicitTarget = c.req.query('target');
        const mode = (c.req.query('mode') ?? '').trim().toLowerCase();
        const userAgent = c.req.header('User-Agent') || '';
        let target;
        try {
            if (explicitTarget !== undefined && !explicitTarget.trim()) throw new InvalidPayloadError('Unsupported target format');
            target = resolveOutputTarget({ explicitTarget, userAgent, collectionDefault: collection.defaultTarget, systemDefault: 'mihomo' });
            if (mode && mode !== 'provider') throw new InvalidPayloadError('Unsupported mode');
            if (mode === 'provider' && target !== 'mihomo') {
                throw new InvalidPayloadError('provider mode is only supported for mihomo target');
            }
        } catch (error) {
            if (error instanceof InvalidPayloadError) return textError(400, error.message);
            throw error;
        }

        const cacheTtlMs = (config?.cacheTtlSeconds ?? 21600) * 1000;
        const maxStaleMs = (config?.maxStaleSeconds ?? 604800) * 1000;
        const now = Date.now();
        const entries = [];
        const sourceRefresher = getRefresher(hub);
        for (const id of collection.sourceIds) {
            const source = await repo.getSource(id);
            if (!source?.enabled) continue;

            const hasNodes = Array.isArray(source.nodes) && source.nodes.length > 0;
            const age = source.lastSuccessAt ? now - source.lastSuccessAt : Infinity;
            if (hasNodes && age <= cacheTtlMs) {
                entries.push(toEntry(source));
            } else if (hasNodes && age <= maxStaleMs) {
                entries.push(toEntry(source));
                const background = sourceRefresher.refreshSource(source.id).catch(() => {});
                try {
                    c.executionCtx?.waitUntil?.(background);
                } catch {
                    // The refresh can continue in runtimes that lack a request execution context.
                }
            } else {
                const result = await sourceRefresher.refreshSource(source.id, { now });
                if (result.ok && result.source?.nodes?.length) entries.push(toEntry(result.source));
            }
        }

        const { nodes } = mergeSourceNodes(entries, collection);
        if (!nodes.length) return textError(503, 'No available proxy nodes');

        try {
            const output = formatSubscriptionOutput(nodes, { target, mode, userAgent });
            return c.text(output.body, 200, { 'Content-Type': output.contentType });
        } catch (error) {
            if (error instanceof InvalidConfigError) return textError(503, error.message);
            throw error;
        }
    });
}
