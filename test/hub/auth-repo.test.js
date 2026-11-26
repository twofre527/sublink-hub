import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { Hono } from 'hono';

vi.mock('ioredis', () => ({ default: class Redis {} }));
import schema from '../../migrations/0001_hub_init.sql?raw';
import cacheTtlMigration from '../../migrations/0002_collection_cache_ttl.sql?raw';
import { createApp } from '../../src/app/createApp.jsx';
import { registerHub } from '../../src/hub/index.jsx';
import { createFieldCipher, constantTimeEqual, hashPassword, randomBase64Url, sha256Hex, verifyPassword } from '../../src/hub/crypto.js';
import { createD1HubRepo, createMemoryHubRepo } from '../../src/hub/repo.js';
import {
    buildSessionCookie, createAuthService, getClientIp, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS,
    parseCookies, REMEMBER_TTL_MS, SESSION_TTL_MS
} from '../../src/hub/auth.js';
import { createCloudflareRuntime } from '../../src/runtime/cloudflare.js';
import { createNodeRuntime } from '../../src/runtime/node.js';
import { createVercelRuntime } from '../../src/runtime/vercel.js';

const password = 'test password';
const origin = 'https://hub.example';
const makePassword = () => hashPassword(password, { iterations: 10000 });
const applySchema = () => applyD1Migrations(env.HUB_DB, [
    { name: '0001_hub_init.sql', queries: schema.split(';').map(query => query.trim()).filter(Boolean) },
    { name: '0002_collection_cache_ttl.sql', queries: cacheTtlMigration.split(';').map(query => query.trim()).filter(Boolean) }
]);

function loginRequest(app, credentials, headers = {}) {
    return app.request(origin + '/api/hub/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(credentials)
    });
}

describe('Hub authentication', () => {
    it('issues short and remembered sessions and clears previous failures on success', async () => {
        const repo = createMemoryHubRepo();
        const auth = createAuthService({ repo, adminPasswordHash: await makePassword() });
        const ip = '192.0.2.1';
        const now = 100;
        await auth.login({ password: 'wrong', ip, now });
        expect((await repo.getLoginRateLimit(ip, { now })).remaining).toBe(LOGIN_MAX_ATTEMPTS - 1);
        const normal = await auth.login({ password, ip, now });
        expect(normal).toMatchObject({ ok: true, maxAgeSeconds: SESSION_TTL_MS / 1000 });
        expect((await repo.getLoginRateLimit(ip, { now })).remaining).toBe(LOGIN_MAX_ATTEMPTS);
        expect(await repo.getSession(normal.token, now)).toBeNull();
        expect(await auth.validateSession(normal.token, now)).toEqual({
            tokenHash: await sha256Hex(normal.token), createdAt: now, expiresAt: now + SESSION_TTL_MS
        });
        expect(await auth.validateSession(normal.token, now + SESSION_TTL_MS)).toBeNull();
        const remembered = await auth.login({ password, rememberMe: true, ip, now });
        expect(remembered.maxAgeSeconds).toBe(REMEMBER_TTL_MS / 1000);
        expect(await auth.validateSession(remembered.token, now + SESSION_TTL_MS)).toBeTruthy();
        await auth.logout(remembered.token);
        expect(await auth.validateSession(remembered.token, now)).toBeNull();
        expect(await auth.validateSession(null, now)).toBeNull();
    });

    it('uses first-party IP and cookie settings including local HTTP development', () => {
        const context = headers => ({ req: { header: key => headers[key] } });
        expect(getClientIp(context({ 'CF-Connecting-IP': 'cf', 'X-Forwarded-For': 'first, second' }))).toBe('cf');
        expect(getClientIp(context({ 'X-Forwarded-For': 'first, second' }))).toBe('first');
        expect(getClientIp(context({}))).toBe('unknown');
        expect(parseCookies(' other=a=b; hub_session=token')).toMatchObject({ other: 'a=b', hub_session: 'token' });
        for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
            expect(buildSessionCookie('token', { maxAgeSeconds: 60, requestUrl: url })).not.toContain('; Secure');
        }
        expect(buildSessionCookie('token', { maxAgeSeconds: 60, requestUrl: origin })).toContain('; Secure');
    });
});

describe('Hub HTTP routes', () => {
    it('preserves the legacy app by default and reports the missing Hub configuration', async () => {
        const plain = createApp();
        expect((await plain.request(origin + '/')).status).toBe(200);
        expect((await plain.request(origin + '/singbox')).status).toBe(400);
        const required = createApp({ hub: { authRequired: true } });
        for (const [app, path, code] of [
            [plain, '/admin', 'AUTH_NOT_CONFIGURED'],
            [plain, '/api/hub/sources', 'AUTH_NOT_CONFIGURED'],
            [required, '/', 'AUTH_NOT_CONFIGURED'],
            [createApp({ hub: { adminPasswordHash: await makePassword() } }), '/admin', 'HUB_DB_NOT_CONFIGURED']
        ]) {
            const response = await app.request(origin + path);
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ error: { code } });
        }
        expect((await loginRequest(plain, { password })).status).toBe(503);
        const malformed = await createApp({ hub: { repo: createMemoryHubRepo(), adminPasswordHash: await makePassword() } })
            .request(origin + '/api/hub/login', { method: 'POST', body: 'not-json' });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_PAYLOAD' } });
    });

    it('protects Hub and legacy routes, requires same-origin writes, and immediately revokes logout', async () => {
        const app = createApp({ hub: { repo: createMemoryHubRepo(), adminPasswordHash: await makePassword() } });
        for (const [path, headers] of [['/', {}], ['/admin', {}], ['/admin/collections', {}], ['/singbox', { Accept: 'text/html' }]]) {
            const response = await app.request(origin + path, { headers });
            expect(response.status).toBe(302);
            expect(response.headers.get('Location')).toBe('/login');
            expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        }
        for (const path of ['/api/hub/sources', '/singbox', '/sub/token/extra']) {
            const response = await app.request(origin + path);
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
            expect(response.headers.get('Cache-Control')).toBe('no-store');
        }
        const signedIn = await loginRequest(app, { password, rememberMe: true });
        expect(signedIn.status).toBe(200);
        const cookie = signedIn.headers.get('Set-Cookie');
        for (const flag of ['HttpOnly', 'Path=/', 'SameSite=Strict', 'Secure', `Max-Age=${REMEMBER_TTL_MS / 1000}`]) {
            expect(cookie).toContain(flag);
        }
        const headers = { Cookie: cookie.split(';')[0] };
        const rootRes = await app.request(origin + '/', { headers });
        expect(rootRes.status).toBe(200);
        expect(rootRes.headers.get('Cache-Control')).toBe('private, no-store');
        expect(rootRes.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect((await app.request(origin + '/shorten-v2?url=https://example.com', { headers })).status).toBe(405);
        for (const path of ['/shorten-v2', '/api/hub/logout']) {
            for (const extra of [{}, { Referer: 'malformed' }, { Origin: 'https://other.example' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }]) {
                const res = await app.request(origin + path, { method: 'POST', headers: { ...headers, ...extra } });
                expect(res.status).toBe(403);
                expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } });
            }
        }
        const legacyWrite = await app.request(origin + '/shorten-v2', { method: 'POST', headers: { ...headers, Origin: origin } });
        expect(legacyWrite.status).toBe(400);
        const logout = await app.request(origin + '/api/hub/logout', {
            method: 'POST', headers: { ...headers, Referer: origin + '/admin' }
        });
        expect(logout.status).toBe(200);
        expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
        expect((await app.request(origin + '/api/hub/sources', { headers })).status).toBe(401);
    });

    it('applies the login origin policy and sends a per-IP Retry-After on throttling', async () => {
        const repo = createMemoryHubRepo();
        const app = createApp({ hub: { repo, adminPasswordHash: await makePassword() } });
        for (const headers of [{ Origin: 'null' }, { Referer: 'https://other.example/login' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
            expect((await loginRequest(app, { password }, headers)).status).toBe(403);
        }
        for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
            const failure = await loginRequest(app, { password: 'wrong' });
            expect(failure.status).toBe(401);
            expect(await failure.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
        }
        const throttled = await loginRequest(app, { password });
        expect(throttled.status).toBe(429);
        expect(await throttled.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
        expect(Number(throttled.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(Number(throttled.headers.get('Retry-After'))).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000);
        expect((await loginRequest(app, { password }, { Origin: origin, 'CF-Connecting-IP': '192.0.2.10' })).status).toBe(200);
        expect((await repo.getLoginRateLimit('192.0.2.10')).remaining).toBe(LOGIN_MAX_ATTEMPTS);

        const concurrentResults = await Promise.all(
            Array.from({ length: 7 }, () => loginRequest(app, { password: 'wrong' }, { Origin: origin, 'CF-Connecting-IP': '192.0.2.20' }))
        );
        const statuses = concurrentResults.map(res => res.status).sort((a, b) => a - b);
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    });

    it('exposes only the public read routes and passes Hub context to mounted handlers', async () => {
        const repo = createMemoryHubRepo();
        const app = new Hono();
        registerHub(app, {
            hub: { repo, adminPasswordHash: await makePassword() },
            assetFetcher: request => new Response(new URL(request.url).pathname)
        }, {
            mountApiRoutes: router => router.get('/api/hub/context', c => c.json({ attached: c.get('hub').repo === repo })),
            mountSubRoutes: router => router.get('/sub/:token', c => c.text(c.req.param('token'))),
            mountPageRoutes: router => router.get('/login', c => c.html('login'))
        });
        app.get('/favicon.ico', c => c.text('favicon'));
        for (const path of ['/hub.css', '/hub.js']) {
            const res = await app.request(origin + path);
            expect(await res.text()).toBe(path);
            expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        }
        for (const path of ['/login', '/sub/token', '/favicon.ico', '/hub.css', '/hub.js']) {
            expect((await app.request(origin + path, { method: 'HEAD' })).status).toBe(200);
            expect((await app.request(origin + path, { method: 'POST' })).status).toBe(401);
        }
        const page = await app.request(origin + '/login');
        expect(page.headers.get('X-Frame-Options')).toBe('DENY');
        expect(page.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(page.headers.get('Cache-Control')).toBe('no-store');
        expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
        const res = await loginRequest(app, { password });
        const headers = { Cookie: res.headers.get('Set-Cookie').split(';')[0] };
        expect(await (await app.request(origin + '/api/hub/context', { headers })).json()).toEqual({ attached: true });
    });

    it('uses the Cloudflare D1 binding for login and session validation across app instances', async () => {
        await applySchema();
        const runtime = createCloudflareRuntime({
            HUB_DB: env.HUB_DB, ADMIN_PASSWORD_HASH: await makePassword(),
            DATA_ENCRYPTION_KEY: randomBase64Url(), HUB_AUTH_REQUIRED: 'true'
        });
        const res = await loginRequest(createApp(runtime), { password });
        expect(res.status).toBe(200);
        const headers = { Cookie: res.headers.get('Set-Cookie').split(';')[0] };
        expect((await createApp(runtime).request(origin + '/', { headers })).status).toBe(200);
    });

    it('forwards hub auth env vars in Node and Vercel runtimes and fails closed without DB', async () => {
        const hash = await makePassword();
        for (const rt of [
            createNodeRuntime({ ADMIN_PASSWORD_HASH: hash, HUB_AUTH_REQUIRED: 'true', DISABLE_MEMORY_KV: 'true' }),
            createVercelRuntime({ ADMIN_PASSWORD_HASH: hash, HUB_AUTH_REQUIRED: 'true' })
        ]) {
            const app = createApp(rt);
            expect((await app.request(origin + '/')).status).toBe(503);
            expect((await app.request(origin + '/admin')).status).toBe(503);
            expect((await app.request(origin + '/clash')).status).toBe(503);
        }
    });
});

describe('Hub cryptography', () => {
    it('generates independent URL-safe tokens and lowercase SHA-256 lookup keys', async () => {
        const token = randomBase64Url();
        expect(token).toMatch(/^[\w-]{43}$/);
        expect(randomBase64Url(16)).toMatch(/^[\w-]{22}$/);
        expect(randomBase64Url()).not.toBe(token);
        const lookup = await sha256Hex(token);
        expect(lookup).toMatch(/^[a-f0-9]{64}$/);
        expect(await sha256Hex(token)).toBe(lookup);
        expect(await sha256Hex(token + 'x')).not.toBe(lookup);
    });

    it('compares all bytes including unequal lengths, trailing zeros and UTF-8', () => {
        expect(constantTimeEqual('密码', new TextEncoder().encode('密码'))).toBe(true);
        expect(constantTimeEqual('', new Uint8Array())).toBe(true);
        expect(constantTimeEqual('ab', 'ac')).toBe(false);
        expect(constantTimeEqual(new Uint8Array(1), new Uint8Array(2))).toBe(false);
    });

    it('checks the password, salt format and Workers iteration limit', async () => {
        const encoded = await hashPassword(password);
        expect(encoded).toMatch(/^pbkdf2_sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
        expect(await verifyPassword(password, encoded)).toBe(true);
        expect(await verifyPassword('other', encoded)).toBe(false);
        expect(await verifyPassword(null, encoded)).toBe(false);
        const other = await makePassword();
        expect(other.split('$')[2]).not.toBe(encoded.split('$')[2]);
        for (const invalid of [null, 'invalid', other + '$extra', other.replace('$10000$', '$9999$'), other.replace('$10000$', '$100001$')]) {
            expect(await verifyPassword(password, invalid)).toBe(false);
        }
        await expect(hashPassword('')).rejects.toThrow();
        for (const iterations of [0, 9999, 100001]) {
            await expect(hashPassword(password, { iterations })).rejects.toThrow();
        }
    });

    it('binds ciphertext to its row and accepts legacy plaintext and all three key encodings', async () => {
        const hex = 'fb'.repeat(32);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(251)));
        const urlKey = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const cipher = createFieldCipher(hex);
        const encrypted = await cipher.encrypt('订阅', 'source:1:url');
        expect(encrypted).toMatch(/^enc:v1:[\w-]{16}:[\w-]+$/);
        expect(await cipher.encrypt('订阅', 'source:1:url')).not.toBe(encrypted);
        for (const key of [hex, base64, urlKey]) {
            expect(await createFieldCipher(key).decrypt(encrypted, 'source:1:url')).toBe('订阅');
        }
        await expect(cipher.decrypt(encrypted, 'source:2:url')).rejects.toThrow();
        const parts = encrypted.split(':');
        parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
        await expect(cipher.decrypt(parts.join(':'), 'source:1:url')).rejects.toThrow();
        expect(await cipher.decrypt('legacy')).toBe('legacy');
        expect(() => createFieldCipher('abcd')).toThrow(/32 bytes/);
        const plain = createFieldCipher(null);
        expect(plain.enabled).toBe(false);
        expect(await plain.encrypt('url')).toBe('url');
        expect(await plain.decrypt('url')).toBe('url');
    });
});

describe.each(['memory', 'D1'])('%s Hub repository', backend => {
    let repo, cipher;
    beforeEach(async () => {
        cipher = createFieldCipher(randomBase64Url());
        if (backend === 'D1') {
            await applySchema();
            await env.HUB_DB.batch(['sessions', 'login_attempts', 'collections', 'sources']
                .map(table => env.HUB_DB.prepare(`DELETE FROM ${table}`)));
            repo = createD1HubRepo(env.HUB_DB, { cipher });
        } else {
            repo = createMemoryHubRepo({ cipher });
        }
    });

    it('persists source edits and retains the last successful refresh through conflicts and failures', async () => {
        const s = await repo.createSource({ alias: 'A', url: 'https://feed.example' });
        expect(s).toMatchObject({
            inputFormat: 'auto', requestUA: 'clash.meta', status: 'pending', enabled: true, cacheVersion: 0,
            nodes: [], nodeCount: 0, diagnostics: [], lastSuccessAt: null, lastAttemptAt: null
        });
        const patch = { alias: 'B', url: 'https://feed.example/2', enabled: false, requestUA: 'client', inputFormat: 'clash' };
        const updated = await repo.updateSource(s.id, patch);
        expect(updated).toMatchObject({ ...patch, cacheVersion: 1, lastSuccessAt: null });
        const payload = { nodes: [{ tag: 'one' }], droppedCount: 2, diagnostics: ['skipped'], attemptedAt: 100, expectedVersion: updated.cacheVersion };
        const refreshed = await repo.saveSourceRefreshSuccess(s.id, payload);
        expect(refreshed).toMatchObject({ updated: true, source: { status: 'ok', lastError: null, cacheVersion: 2, nodeCount: 1 } });
        if (backend === 'D1') {
            const rawNodes = await env.HUB_DB.prepare('SELECT nodes_json FROM sources WHERE id = ?').bind(s.id).first();
            expect(rawNodes.nodes_json).toMatch(/^enc:v1:/);
        }
        expect(await repo.saveSourceRefreshSuccess(s.id, { ...payload, nodes: [] })).toEqual({ updated: false, conflict: true });
        // Stale failure with old expectedVersion must not clobber newer successful snapshot.
        expect(await repo.saveSourceRefreshFailure(s.id, { error: 'stale error', attemptedAt: 150, expectedVersion: 1 })).toBeNull();
        expect((await repo.getSource(s.id)).status).toBe('ok');
        const failed = await repo.saveSourceRefreshFailure(s.id, { error: new Error('timeout'), attemptedAt: 200, expectedVersion: 2 });
        expect(failed).toMatchObject({
            nodes: payload.nodes, nodeCount: 1, droppedCount: 2, diagnostics: payload.diagnostics,
            status: 'error', lastError: 'Error: timeout', lastAttemptAt: 200, lastSuccessAt: 100, cacheVersion: 2
        });
        expect(await repo.listSources()).toEqual([failed]);
        expect(await repo.getSource(s.id)).toEqual(failed);
        expect(await repo.saveSourceRefreshSuccess(s.id, { nodes: [] })).toMatchObject({
            updated: true, source: { status: 'ok', cacheVersion: 3, nodes: [], lastError: null }
        });
        expect(await repo.deleteSource(s.id)).toEqual({ deleted: true });
        expect(await repo.getSource(s.id)).toBeNull();
        expect(await repo.updateSource(s.id, patch)).toBeNull();
        expect(await repo.saveSourceRefreshFailure(s.id, { error: 'late' })).toBeNull();
        expect(await repo.saveSourceRefreshSuccess(s.id, payload)).toEqual({ updated: false, conflict: false });
        expect(await repo.deleteSource(s.id)).toEqual({ deleted: false, notFound: true });
    });

    it('rotates collection credentials, preserves referenced sources and binds encrypted fields to their records', async () => {
        const s = await repo.createSource({ alias: 'feed', url: 'https://feed.example/a' });
        const c = await repo.createCollection({ alias: 'collection', sourceIds: [s.id] });
        expect(c).toMatchObject({ prefixEnabled: true, deduplicate: true, defaultTarget: 'mihomo', enabled: true, tokenVersion: 1 });
        const originalLookup = await sha256Hex(c.token);
        if (backend === 'D1') {
            const rawSource = await env.HUB_DB.prepare('SELECT url FROM sources WHERE id = ?').bind(s.id).first();
            const rawCollection = await env.HUB_DB.prepare('SELECT token, token_hash FROM collections WHERE id = ?').bind(c.id).first();
            expect(rawSource.url).toMatch(/^enc:v1:/);
            expect(rawCollection.token).toMatch(/^enc:v1:/);
            expect(await cipher.decrypt(rawSource.url, `source:${s.id}:url`)).toBe(s.url);
            expect(await cipher.decrypt(rawCollection.token, `collection:${c.id}:token`)).toBe(c.token);
            expect(rawCollection.token_hash).toBe(originalLookup);
        }
        const patch = { alias: 'edited', prefixEnabled: false, deduplicate: false, defaultTarget: 'surge', enabled: false };
        const edited = await repo.updateCollection(c.id, { ...patch, token: 'override', tokenVersion: 100 });
        expect(edited).toMatchObject({ ...patch, token: c.token, tokenVersion: 1 });
        expect(await repo.getCollectionByTokenHash(originalLookup)).toEqual(edited);
        expect(await repo.listCollections()).toEqual([edited]);
        expect(await repo.getCollection(c.id)).toEqual(edited);
        expect(await repo.deleteSource(s.id)).toEqual({ deleted: false, referencedBy: [{ id: c.id, alias: 'edited' }] });
        const rotated = await repo.rotateCollectionToken(c.id);
        expect(rotated.tokenVersion).toBe(2);
        expect(rotated.token).not.toBe(c.token);
        expect(await repo.getCollectionByTokenHash(originalLookup)).toBeNull();
        expect(await repo.getCollectionByTokenHash(await sha256Hex(rotated.token))).toEqual(rotated);
        expect(await repo.updateCollection(c.id, { sourceIds: [] })).toMatchObject({ sourceIds: [] });
        expect(await repo.deleteSource(s.id)).toEqual({ deleted: true });
        expect(await repo.deleteCollection(c.id)).toBe(true);
        expect(await repo.deleteCollection(c.id)).toBe(false);
        expect(await repo.updateCollection(c.id, patch)).toBeNull();
        expect(await repo.rotateCollectionToken(c.id)).toBeNull();
    });

    it('expires and revokes sessions and enforces fixed per-IP failure windows', async () => {
        await repo.createSession('session-a', 12, 10);
        await repo.createSession('session-b', 15, 10);
        await repo.createSession('session-c', 20, 10);
        expect(await repo.getSession('session-a', 11)).toEqual({ tokenHash: 'session-a', createdAt: 10, expiresAt: 12 });
        expect(await repo.getSession('session-a', 12)).toBeNull();
        expect(await repo.getSession('session-a', 10)).toBeNull();
        await repo.purgeExpiredSessions(15);
        expect(await repo.getSession('session-b', 10)).toBeNull();
        expect(await repo.getSession('session-c', 15)).toBeTruthy();
        await repo.deleteSession('session-c');
        expect(await repo.getSession('session-c', 15)).toBeNull();

        const options = { now: 1, maxAttempts: 2, windowMs: 10 };
        expect(await repo.recordLoginFailure('ip', options)).toEqual({ count: 1, blocked: false, resetAt: 11 });
        expect(await repo.recordLoginFailure('ip', { ...options, now: 5 })).toEqual({ count: 2, blocked: true, resetAt: 11 });
        expect(await repo.getLoginRateLimit('ip', options)).toEqual({ blocked: true, remaining: 0, resetAt: 11 });
        expect(await repo.getLoginRateLimit('other', options)).toMatchObject({ blocked: false, remaining: 2 });
        expect(await repo.getLoginRateLimit('ip', { ...options, now: 11 })).toMatchObject({ blocked: false, remaining: 2 });
        expect(await repo.recordLoginFailure('ip', { ...options, now: 11 })).toEqual({ count: 1, blocked: false, resetAt: 21 });
        await repo.clearLoginFailures('ip');
        expect(await repo.getLoginRateLimit('ip', options)).toMatchObject({ remaining: 2 });
    });
});
