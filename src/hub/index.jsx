/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { createFieldCipher } from './crypto.js';
import { createD1HubRepo } from './repo.js';
import { createSourceRefresher, mountHubApiRoutes } from './routes/api.js';
import { mountSubRoutes } from './routes/sub.js';
import {
    applyHubSecurityHeaders, buildClearSessionCookie, buildSessionCookie, createAuthService,
    getClientIp, getSessionTokenFromRequest, verifySameOrigin
} from './auth.js';

const assets = ['/hub.css', '/hub.js'];
const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
const errorResponse = (c, status, code, message) => c.json({ error: { code, message } }, status);
const forbidden = c => errorResponse(c, 403, 'FORBIDDEN_ORIGIN', 'Invalid request origin');
const unauthorized = c => errorResponse(c, 401, 'UNAUTHORIZED', 'Authentication required');

function configurationError(c, adminPasswordHash) {
    return adminPasswordHash
        ? errorResponse(c, 503, 'HUB_DB_NOT_CONFIGURED', 'Hub database is not configured')
        : errorResponse(c, 503, 'AUTH_NOT_CONFIGURED', 'Admin authentication is not configured');
}

export function registerHub(app, runtime, routeMounters = {}) {
    const config = runtime.hub;
    const cipher = createFieldCipher(config?.dataEncryptionKey);
    const repo = config?.repo ?? (config?.db ? createD1HubRepo(config.db, { cipher }) : null);
    const adminPasswordHash = config?.adminPasswordHash || null;
    const auth = repo && adminPasswordHash ? createAuthService({ repo, adminPasswordHash }) : null;
    const refresher = repo ? createSourceRefresher({ repo, fetchImpl: config?.fetchImpl }) : undefined;

    app.use('*', async (c, next) => {
        c.set('hub', { repo, auth, cipher, config, adminPasswordHash });
        const { path, method } = c.req;
        const read = method === 'GET' || method === 'HEAD';
        if (read && (path === '/favicon.ico' || assets.includes(path) || /^\/sub\/[^/]+$/.test(path))) return next();
        if (read && path === '/login') {
            applyHubSecurityHeaders(c, { isHtml: true });
            return next();
        }
        if (method === 'POST' && path === '/api/hub/login') {
            applyHubSecurityHeaders(c);
            return verifySameOrigin(c, { allowMissing: true }) ? next() : forbidden(c);
        }

        const isHtmlPath = path === '/admin' || path.startsWith('/admin/');
        const hubPath = isHtmlPath || path.startsWith('/api/hub/');
        if (hubPath) {
            applyHubSecurityHeaders(c, { isHtml: isHtmlPath });
            if (!auth) return configurationError(c, adminPasswordHash);
        } else {
            if (!adminPasswordHash && !config?.authRequired) return next();
            if (!auth) {
                applyHubSecurityHeaders(c);
                return configurationError(c, adminPasswordHash);
            }
        }

        if (!await auth.validateSession(getSessionTokenFromRequest(c))) {
            const redirect = read && (hubPath ? isHtmlPath : path === '/' || c.req.header('Accept')?.includes('text/html'));
            if (!hubPath) applyHubSecurityHeaders(c, { isHtml: redirect });
            return redirect ? c.redirect('/login', 302) : unauthorized(c);
        }
        if (mutationMethods.includes(method) && !verifySameOrigin(c)) {
            if (!hubPath) applyHubSecurityHeaders(c);
            return forbidden(c);
        }
        return next();
    });

    for (const path of assets) {
        app.get(path, async c => {
            if (!runtime.assetFetcher) {
                c.header('X-Content-Type-Options', 'nosniff');
                return c.notFound();
            }
            const asset = await runtime.assetFetcher(c.req.raw);
            const response = new Response(asset.body, asset);
            response.headers.set('X-Content-Type-Options', 'nosniff');
            return response;
        });
    }

    app.post('/api/hub/login', async c => {
        if (!auth) return configurationError(c, adminPasswordHash);
        const credentials = await c.req.json().catch(() => null);
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
            return errorResponse(c, 400, 'INVALID_PAYLOAD', 'Invalid JSON body');
        }
        const result = await auth.login({
            password: credentials?.password, rememberMe: credentials?.rememberMe === true, ip: getClientIp(c)
        });
        if (!result.ok) {
            if (result.status === 429) c.header('Retry-After', String(result.retryAfterSeconds));
            return errorResponse(c, result.status, result.code, result.message);
        }
        c.header('Set-Cookie', buildSessionCookie(result.token, { maxAgeSeconds: result.maxAgeSeconds, requestUrl: c.req.url }));
        return c.json({ ok: true });
    });

    app.post('/api/hub/logout', async c => {
        await auth.logout(getSessionTokenFromRequest(c));
        c.header('Set-Cookie', buildClearSessionCookie({ requestUrl: c.req.url }));
        return c.json({ ok: true });
    });

    (routeMounters.mountApiRoutes ?? (a => mountHubApiRoutes(a, { refresher })))(app);
    (routeMounters.mountSubRoutes ?? (a => mountSubRoutes(a, { refresher })))(app);
    routeMounters.mountPageRoutes?.(app);
}
