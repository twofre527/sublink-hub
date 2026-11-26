import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import css from '../../public/hub.css?raw';
import script from '../../public/hub.js?raw';
import { createFileAssetFetcher } from '../../src/adapters/assets/fileAssetFetcher.js';
import { registerHub } from '../../src/hub/index.jsx';

vi.mock('../../src/hub/auth.js', async importOriginal => ({
    ...await importOriginal(),
    createAuthService: () => ({ validateSession: async token => token === 'ui-session' })
}));

vi.mock('fs/promises', () => ({
    async readFile(path) {
        // Raw imports expose the project assets in the Workers test environment.
        if (path.endsWith('/public/hub.css')) return css;
        if (path.endsWith('/public/hub.js')) return script;
        throw new Error('File missing: ' + path);
    }
}));

const session = { headers: { Cookie: 'hub_session=ui-session' } };

function makeApp(hub) {
    const app = new Hono();
    registerHub(app, { hub, assetFetcher: createFileAssetFetcher('public') });
    return app;
}

const configuredApp = () => makeApp({ repo: {}, adminPasswordHash: 'configured' });

async function expectSecurePage(response) {
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"');
    expect(html.match(/<(?:link|script)\b[^>]*>/gi)).toEqual([
        expect.stringMatching(/^<link rel="stylesheet" href="\/hub\.css"\s*\/?>$/),
        expect.stringMatching(/^<script defer(?:="")? src="\/hub\.js">$/)
    ]);
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]+|\son[a-z]+\s*=/i);
    return html;
}

describe('Hub management UI', () => {
    it('serves a secure login page and shows the configuration warning', async () => {
        const html = await expectSecurePage(await makeApp().request('/login'));
        expect(html).toContain('data-page="login"');
        expect(html).toContain('未配置 ADMIN_PASSWORD_HASH 或 HUB_DB，无法登录');
        expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>登录<\/button>/);
    });

    it('redirects a valid session from login to admin', async () => {
        const response = await configuredApp().request('/login', session);
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/admin');
    });

    it('redirects unauthenticated requests and renders the protected admin shell', async () => {
        const app = configuredApp();
        const redirect = await app.request('/admin');
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get('Location')).toBe('/login');
        const html = await expectSecurePage(await app.request('/admin', session));
        for (const id of ['panel-sources', 'panel-collections', 'logout-btn', 'preview-modal']) {
            expect(html).toContain(`id="${id}"`);
        }
    });

    it('redirects authenticated admin subpaths to the admin shell', async () => {
        const response = await configuredApp().request('/admin/extra', session);
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/admin');
    });

    it.each([
        ['/hub.css', 'text/css', css],
        ['/hub.js', 'text/javascript', script]
    ])('serves %s with the correct MIME type and nosniff', async (path, mime, body) => {
        const response = await makeApp().request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('Content-Type')).toBe(mime);
        expect(await response.text()).toBe(body);
    });

    it('uses DOM construction for subscription data', () => {
        expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    });
});
