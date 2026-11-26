import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app/createApp.jsx';
import { createFieldCipher, hashPassword } from '../../src/hub/crypto.js';
import { createMemoryHubRepo } from '../../src/hub/repo.js';

const origin = 'https://hub.example';
const password = 'hub admin password';
const dataEncryptionKey = 'ab'.repeat(32);
const feedA = 'https://a.example/private-feed?key=secret-a';
const feedB = 'https://b.example/other-feed?key=secret-b';
const editedFeed = 'https://a.example/updated-feed?key=secret-edit';
const uuid = '11111111-1111-4111-8111-111111111111';
const yamlFeed = yaml.dump({
    proxies: [
        { name: 'Shared', type: 'ss', server: 'ss.example', port: 443, cipher: 'aes-128-gcm', password: 'ss-secret' },
        { name: 'Duplicate', type: 'ss', server: 'ss.example', port: 443, cipher: 'aes-128-gcm', password: 'ss-secret' },
        { name: 'VMess', type: 'vmess', server: 'vmess.example', port: 443, uuid, alterId: 0, cipher: 'auto', tls: true }
    ]
});
const base64Feed = btoa('trojan://trojan-secret@trojan.example:443?sni=trojan.example#Trojan');
const editedYaml = yaml.dump({
    proxies: [{ name: 'Updated', type: 'ss', server: 'new.example', port: 443, cipher: 'aes-128-gcm', password: 'new-secret' }]
});

async function setup(feeds = new Map([[feedA, yamlFeed], [feedB, base64Feed], [editedFeed, editedYaml]]), cache = {}) {
    const repo = createMemoryHubRepo({ cipher: createFieldCipher(dataEncryptionKey) });
    const fetchImpl = vi.fn(async url => {
        const body = feeds.get(url);
        if (typeof body === 'function') return body();
        return new Response(body ?? '', { status: body === undefined ? 500 : 200 });
    });
    const app = createApp({
        hub: {
            repo, adminPasswordHash: await hashPassword(password, { iterations: 10 }), dataEncryptionKey,
            fetchImpl, cacheTtlSeconds: 60, maxStaleSeconds: 120, ...cache
        }
    });
    const login = await app.request(origin + '/api/hub/login', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const api = (path, method = 'GET', data) => app.request(origin + '/api/hub' + path, {
        method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: typeof data === 'string' ? data : JSON.stringify(data)
    });
    const sub = (path, userAgent = '', ctx) => app.request(origin + path, {
        headers: { 'User-Agent': userAgent }
    }, undefined, ctx);
    return { api, sub, app, repo, fetchImpl, feeds };
}

async function json(response, status = 200) {
    const res = await response;
    expect(res.status).toBe(status);
    return res.json();
}

async function createSource(api, alias = 'A', url = feedA, fields = {}) {
    return (await json(api('/sources', 'POST', { alias, url, ...fields }), 201)).source;
}

async function createCollection(api, alias, sourceIds, fields = {}) {
    return (await json(api('/collections', 'POST', { alias, sourceIds, ...fields }), 201)).collection;
}

async function yamlNodes(response) {
    const res = await response;
    expect(res.status).toBe(200);
    return yaml.load(await res.text()).proxies;
}

function expectSubHeaders(response) {
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('User-Agent');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('Hub source and collection APIs', () => {
    it('imports YAML and Base64, masks feed URLs, and projects sanitized previews', async () => {
        const { api, fetchImpl } = await setup();
        const a = await createSource(api, ' A ', feedA, { inputFormat: 'yaml', requestUA: ' custom-client ' });
        const b = await createSource(api, 'B', feedB, { inputFormat: 'base64' });
        expect(a).toMatchObject({ alias: 'A', maskedUrl: 'https://a.example/•••', nodeCount: 3, status: 'ok', requestUA: 'custom-client' });
        expect(b).toMatchObject({ maskedUrl: 'https://b.example/•••', nodeCount: 1, status: 'ok', requestUA: 'clash.meta' });
        expect(fetchImpl).toHaveBeenCalledWith(feedA, expect.objectContaining({ headers: { 'User-Agent': 'custom-client' } }));
        const { sources } = await json(api('/sources'));
        expect(sources).toEqual(expect.arrayContaining([a, b]));
        expect(JSON.stringify(sources)).not.toMatch(/private-feed|other-feed|secret-a|secret-b/);
        expect(await json(api('/sources/' + a.id))).toEqual({ source: a });

        const preview = await json(api('/sources/' + a.id + '/nodes'));
        expect(preview.nodes).toEqual([
            { tag: 'Shared', type: 'shadowsocks', server: 'ss.example', port: 443, tls: false, transport: 'tcp' },
            { tag: 'Duplicate', type: 'shadowsocks', server: 'ss.example', port: 443, tls: false, transport: 'tcp' },
            { tag: 'VMess', type: 'vmess', server: 'vmess.example', port: 443, tls: true, transport: 'tcp' }
        ]);
        const collection = await createCollection(api, 'All', [a.id, b.id]);
        const merged = await json(api('/collections/' + collection.id + '/nodes'));
        expect(merged).toMatchObject({ nodeCount: 3, totalBeforeDedup: 4, dedupedCount: 1, warnings: [] });
        expect(merged.nodes.map(node => node.tag)).toEqual(['A | Shared', 'A | VMess', 'B | Trojan']);
        expect(JSON.stringify(merged.nodes)).not.toMatch(/password|uuid|ss-secret|trojan-secret|11111111/);
    });

    it('isolates subscription output, applies source changes, and protects referenced sources', async () => {
        const { api, sub, repo } = await setup();
        const a = await createSource(api);
        const b = await createSource(api, 'B', feedB);
        const all = await createCollection(api, 'All', [a.id, b.id]);
        const onlyA = await createCollection(api, 'Only A', [a.id], { prefixEnabled: false });
        expect(all).toMatchObject({ prefixEnabled: true, deduplicate: true, mergedNodeCount: 3 });
        expect(onlyA).toMatchObject({ mergedNodeCount: 2 });
        expect((await yamlNodes(sub(all.subscriptionPath))).map(node => node.name)).toEqual(['A | Shared', 'A | VMess', 'B | Trojan']);
        expect((await yamlNodes(sub(onlyA.subscriptionPath))).map(node => node.name)).toEqual(['Shared', 'VMess']);
        const collectionPath = '/collections/' + all.id;
        expect((await json(api('/collections'))).collections).toEqual(expect.arrayContaining([all, onlyA]));
        expect(await json(api(collectionPath))).toEqual({ collection: all });

        const sourcePath = '/sources/' + a.id;
        expect((await json(api(sourcePath, 'PUT', { url: '' }))).source.maskedUrl).toBe(a.maskedUrl);
        expect((await repo.getSource(a.id)).url).toBe(feedA);
        await json(api(sourcePath, 'PUT', { alias: 'Updated A', url: editedFeed }));
        expect((await json(api(sourcePath + '/refresh', 'POST'))).source).toMatchObject({ status: 'ok', cacheVersion: 2 });
        expect((await yamlNodes(sub(all.subscriptionPath))).map(node => node.name)).toEqual(['Updated A | Updated', 'B | Trojan']);
        expect((await yamlNodes(sub(onlyA.subscriptionPath))).map(node => node.name)).toEqual(['Updated']);

        expect(await json(api('/sources/' + b.id, 'DELETE'), 409)).toMatchObject({
            error: { code: 'SOURCE_IN_USE' }, collections: [{ id: all.id, alias: 'All' }]
        });
        const updated = (await json(api(collectionPath, 'PUT', { sourceIds: [a.id] }))).collection;
        expect(updated).toMatchObject({ subscriptionPath: all.subscriptionPath, tokenVersion: all.tokenVersion, mergedNodeCount: 1 });
        expect(await json(api('/sources/' + b.id, 'DELETE'))).toEqual({ ok: true });
        expect(await json(api('/sources/' + b.id), 404)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('validates JSON bodies, source fields and collection membership', async () => {
        const { api } = await setup();
        const a = await createSource(api);
        for (const body of ['{', { alias: ' ', url: feedA }, { alias: 'A', url: 'http://a.example' },
            { alias: 'A', url: feedA, inputFormat: 'csv' }, { alias: 'A', url: feedA, enabled: 'yes' }]) {
            expect(await json(api('/sources', 'POST', body), 400)).toMatchObject({ error: { code: 'INVALID_PAYLOAD' } });
        }
        for (const fields of [{ sourceIds: [a.id, a.id] }, { sourceIds: ['unknown'] }, { sourceIds: [1] },
            { sourceIds: [a.id], defaultTarget: 'unsupported' }, { sourceIds: [a.id], prefixEnabled: 1 }]) {
            expect(await json(api('/collections', 'POST', { alias: 'Invalid', ...fields }), 400))
                .toMatchObject({ error: { code: 'INVALID_PAYLOAD' } });
        }
    });

    it('retains successful cache on upstream failures and reports failed initial refreshes', async () => {
        const { api, feeds, sub } = await setup();
        const a = await createSource(api);
        const collection = await createCollection(api, 'All', [a.id]);
        const route = '/sources/' + a.id + '/refresh';
        feeds.delete(feedA);
        const failed = await json(api(route, 'POST'));
        expect(failed).toMatchObject({
            ok: false, staleRetained: true, warning: 'Upstream a.example returned HTTP 500',
            source: { status: 'error', cacheVersion: a.cacheVersion, nodeCount: a.nodeCount, lastSuccessAt: a.lastSuccessAt }
        });
        feeds.set(feedA, 'proxies: []');
        const empty = await json(api(route, 'POST'));
        expect(empty).toMatchObject({
            ok: false, staleRetained: true, warning: 'Upstream returned 0 valid proxy nodes',
            source: { cacheVersion: a.cacheVersion, nodeCount: a.nodeCount, lastSuccessAt: a.lastSuccessAt }
        });
        expect((await yamlNodes(sub(collection.subscriptionPath))).map(node => node.name)).toEqual(['A | Shared', 'A | VMess']);
        expect((await json(api('/collections/' + collection.id))).collection.warnings).toEqual([
            'Source A refresh failed: Upstream returned 0 valid proxy nodes'
        ]);

        const unavailable = await createSource(api, 'Unavailable', 'https://down.example/private?token=credential');
        expect(unavailable).toMatchObject({ status: 'error', nodeCount: 0, lastError: 'Upstream down.example returned HTTP 500' });
        expect(JSON.stringify(unavailable)).not.toMatch(/private|credential/);
        expect(await json(api('/sources/' + unavailable.id + '/refresh', 'POST'), 502)).toMatchObject({
            error: { code: 'UPSTREAM_FAILED' }, source: { status: 'error', nodeCount: 0 }
        });
        const emptyCollection = await createCollection(api, 'Empty', [unavailable.id]);
        const output = await sub(emptyCollection.subscriptionPath + '?target=base64');
        expect(output.status).toBe(503);
        expect(await output.text()).toBe('No available proxy nodes');
    });
});

describe('Hub subscription dispatch', () => {
    it('serves fresh cache, coalesces concurrent stale refreshes and waits for expired cache', async () => {
        const { api, sub, repo, fetchImpl, feeds } = await setup();
        const a = await createSource(api);
        const collection = await createCollection(api, 'All', [a.id]);
        const path = collection.subscriptionPath;
        fetchImpl.mockClear();
        expect((await yamlNodes(sub(path)))[0].name).toBe('A | Shared');
        expect(fetchImpl).toHaveBeenCalledTimes(0);

        const original = await repo.getSource(a.id);
        await repo.saveSourceRefreshSuccess(a.id, { nodes: original.nodes, attemptedAt: Date.now() - 90_000 });
        const background = deferred();
        const started = deferred();
        feeds.set(feedA, () => {
            started.resolve();
            return background.promise;
        });
        const firstContext = createExecutionContext();
        const secondContext = createExecutionContext();
        try {
            const stale = await Promise.all([
                yamlNodes(sub(path, '', firstContext)), yamlNodes(sub(path, '', secondContext))
            ]);
            expect(stale.map(nodes => nodes[0].name)).toEqual(['A | Shared', 'A | Shared']);
            await started.promise;
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        } finally {
            background.resolve(new Response(editedYaml));
            await Promise.all([waitOnExecutionContext(firstContext), waitOnExecutionContext(secondContext)]);
        }
        expect((await yamlNodes(sub(path)))[0].name).toBe('A | Updated');
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await repo.saveSourceRefreshSuccess(a.id, { nodes: original.nodes, attemptedAt: Date.now() - 180_000 });
        const expiredView = (await json(api('/collections/' + collection.id))).collection;
        expect(expiredView).toMatchObject({ mergedNodeCount: 0, warnings: ['Source A cache is stale'] });
        feeds.delete(feedA);
        const expired = await sub(path);
        expect(expired.status).toBe(503);
        expect(await expired.text()).toBe('No available proxy nodes');
        expectSubHeaders(expired);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        feeds.set(feedA, editedYaml);
        expect((await yamlNodes(sub(path)))[0].name).toBe('A | Updated');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('negotiates client formats, honors the explicit target and validates provider mode', async () => {
        const { api, sub } = await setup();
        const a = await createSource(api);
        const collection = await createCollection(api, 'All', [a.id]);
        const path = collection.subscriptionPath;
        const clash = await sub(path, 'Clash Verge/2.0');
        expect(clash.headers.get('Content-Type')).toContain('text/yaml');
        expect(yaml.load(await clash.text())).toMatchObject({ rules: ['MATCH,PROXY'], 'proxy-groups': [{ name: 'PROXY' }] });
        expectSubHeaders(clash);

        const shadowrocket = await sub(path, 'Shadowrocket/2.2');
        expect(shadowrocket.headers.get('Content-Type')).toContain('text/plain');
        expect(atob(await shadowrocket.text())).toMatch(/^ss:\/\//);
        const singbox = await sub(path, 'sing-box/1.14');
        expect(singbox.headers.get('Content-Type')).toContain('application/json');
        expect((await singbox.json()).outbounds).toEqual(expect.arrayContaining([expect.objectContaining({ tag: 'A | Shared' })]));
        const surge = await sub(path, 'Surge/5.0');
        expect(surge.headers.get('Content-Type')).toContain('text/plain');
        expect(await surge.text()).toContain('[Proxy]');

        const provider = await sub(path + '?target=mihomo&mode=provider', 'Shadowrocket/2.2');
        expect(provider.status).toBe(200);
        expect(Object.keys(yaml.load(await provider.text()))).toEqual(['proxies']);
        for (const query of ['?target=', '?target=bad', '?target=singbox&mode=provider', '?mode=bad']) {
            const invalid = await sub(path + query);
            expect(invalid.status).toBe(400);
            expectSubHeaders(invalid);
        }
    });

    it('revokes rotated, disabled, and deleted links and keeps subscription tokens separate from admin sessions', async () => {
        const { api, sub, app } = await setup();
        const a = await createSource(api);
        const collection = await createCollection(api, 'All', [a.id]);
        const path = '/collections/' + collection.id;
        const rotated = (await json(api(path + '/rotate-token', 'POST'))).collection;
        expect(rotated.tokenVersion).toBe(collection.tokenVersion + 1);
        expect(rotated.subscriptionPath).not.toBe(collection.subscriptionPath);
        for (const bad of [collection.subscriptionPath, '/sub/invalid-token']) {
            const missing = await sub(bad);
            expect(missing.status).toBe(404);
            expect(await missing.text()).toBe('Not Found');
            expectSubHeaders(missing);
        }
        for (const token of ['invalid-token', rotated.subscriptionPath.split('/').pop()]) {
            const unauthorized = await app.request(origin + '/api/hub/sources', {
                headers: { Cookie: 'hub_session=' + token }
            });
            expect(unauthorized.status).toBe(401);
        }
        expect((await sub(rotated.subscriptionPath)).status).toBe(200);
        await json(api(path, 'PUT', { enabled: false }));
        expect((await sub(rotated.subscriptionPath)).status).toBe(404);
        await json(api(path, 'PUT', { enabled: true }));
        expect((await sub(rotated.subscriptionPath)).status).toBe(200);
        expect(await json(api(path, 'DELETE'))).toEqual({ ok: true });
        expect((await sub(rotated.subscriptionPath)).status).toBe(404);
        expect(await json(api(path, 'DELETE'), 404)).toMatchObject({ error: { code: 'NOT_FOUND' } });
        const missingRepo = await createApp().request(origin + '/sub/invalid-token');
        expect(missingRepo.status).toBe(503);
        expectSubHeaders(missingRepo);
    });
});
