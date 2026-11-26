import { randomBase64Url, sha256Hex, verifyPassword } from './crypto.js';

export const SESSION_COOKIE_NAME = 'hub_session';
export const SESSION_TTL_MS = 24 * 3600 * 1000;
export const REMEMBER_TTL_MS = 30 * SESSION_TTL_MS;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 5;

export function parseCookies(cookieHeader = '') {
    const cookies = Object.create(null);
    for (const part of (cookieHeader || '').split(';')) {
        const equals = part.indexOf('=');
        if (equals > 0) cookies[part.slice(0, equals).trim()] = part.slice(equals + 1).trim();
    }
    return cookies;
}

export function getSessionTokenFromRequest(c) {
    return parseCookies(c.req.header('Cookie'))[SESSION_COOKIE_NAME] || null;
}

export function buildSessionCookie(rawToken, { maxAgeSeconds, requestUrl }) {
    const { protocol, hostname } = new URL(requestUrl);
    const local = protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
    return `${SESSION_COOKIE_NAME}=${rawToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${local ? '' : '; Secure'}`;
}

export function buildClearSessionCookie({ requestUrl }) {
    return buildSessionCookie('', { maxAgeSeconds: 0, requestUrl });
}

export function getClientIp(c) {
    return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
}

export function verifySameOrigin(c, { allowMissing = false } = {}) {
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
    const expected = new URL(c.req.url).origin;
    const origin = c.req.header('Origin');
    if (origin !== undefined) return origin === expected;
    const referer = c.req.header('Referer');
    if (referer === undefined) return allowMissing;
    try {
        return new URL(referer).origin === expected;
    } catch {
        return false;
    }
}

export function applyHubSecurityHeaders(c, { isHtml = false } = {}) {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (isHtml) {
        c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    }
}

export function createAuthService({ repo, adminPasswordHash }) {
    return {
        async login({ password, rememberMe = false, ip = 'unknown', now = Date.now() }) {
            // Atomically reserve an attempt slot before PBKDF2 to eliminate concurrency bypasses and CPU amplification.
            const attempt = typeof repo.consumeLoginAttempt === 'function'
                ? await repo.consumeLoginAttempt(ip, { now, windowMs: LOGIN_WINDOW_MS, maxAttempts: LOGIN_MAX_ATTEMPTS })
                : null;
            if (attempt ? !attempt.allowed : (await repo.getLoginRateLimit(ip, { now, maxAttempts: LOGIN_MAX_ATTEMPTS })).blocked) {
                const resetAt = attempt ? attempt.resetAt : (await repo.getLoginRateLimit(ip, { now, maxAttempts: LOGIN_MAX_ATTEMPTS })).resetAt;
                return {
                    ok: false, status: 429, code: 'RATE_LIMITED', message: 'Too many login attempts, try again later',
                    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
                };
            }
            if (!await verifyPassword(password, adminPasswordHash)) {
                if (!attempt) {
                    await repo.recordLoginFailure(ip, { now, windowMs: LOGIN_WINDOW_MS, maxAttempts: LOGIN_MAX_ATTEMPTS });
                }
                return { ok: false, status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid password' };
            }
            await repo.clearLoginFailures(ip);
            const token = randomBase64Url(32);
            const ttl = rememberMe ? REMEMBER_TTL_MS : SESSION_TTL_MS;
            await repo.createSession(await sha256Hex(token), now + ttl, now);
            await Promise.allSettled([
                repo.purgeExpiredSessions?.(now),
                repo.purgeExpiredLoginAttempts?.(now)
            ]);
            return { ok: true, token, maxAgeSeconds: ttl / 1000 };
        },
        async validateSession(rawToken, now = Date.now()) {
            return rawToken ? repo.getSession(await sha256Hex(rawToken), now) : null;
        },
        async logout(rawToken) {
            if (rawToken) await repo.deleteSession(await sha256Hex(rawToken));
        }
    };
}
