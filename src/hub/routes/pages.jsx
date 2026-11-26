/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { html } from 'hono/html';
import { APP_NAME, APP_VERSION, GITHUB_REPO } from '../../constants.js';
import { getSessionTokenFromRequest } from '../auth.js';
import { getHubTranslations, resolveHubLanguage } from '../i18n.js';

const inputFormats = ['auto', 'yaml', 'base64', 'uri', 'json', 'surge'];
const outputTargets = ['mihomo', 'base64', 'singbox', 'surge'];

function Page({ title, page, lang = 'zh-CN', children }) {
    return <html lang={lang}>
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex, nofollow" />
            <title>{title}</title>
            <link rel="icon" type="image/x-icon" href="/favicon.ico" />
            <link rel="stylesheet" href="/hub.css" />
            <script defer src="/hub.js"></script>
        </head>
        <body data-page={page}>{children}</body>
    </html>;
}

function LoginPage({ configured, lang }) {
    const t = getHubTranslations(lang);
    const nextLang = lang === 'en-US' ? 'zh-CN' : 'en-US';
    return <Page title={`${APP_NAME} - ${t.loginPageTitle}`} page="login" lang={lang}>
        <main class="card login-card">
            <div class="login-actions">
                <button id="lang-toggle" type="button" class="lang-toggle" data-next-lang={nextLang} aria-label={t.switchLangAria}>{t.switchLangLabel}</button>
            </div>
            <div class="login-brand">
                <img src="/favicon.ico" alt={`${APP_NAME} logo`} class="brand-logo-lg" />
                <h1>{APP_NAME}</h1>
            </div>
            <p class="muted login-subtitle">{t.loginSubtitle}</p>
            {!configured && <p class="notice error" role="alert">{t.notConfiguredError}</p>}
            <form id="login-form" method="post" action="/api/hub/login">
                <label class="field">{t.passwordLabel}
                    <input id="password" type="password" name="password" required autocomplete="current-password" />
                </label>
                <label class="check"><input id="remember-me" type="checkbox" />{t.rememberMeLabel}</label>
                <p id="login-error" class="notice error" role="alert" hidden></p>
                <button type="submit" class="primary" disabled={!configured}>{t.loginButton}</button>
            </form>
        </main>
    </Page>;
}

function FormActions({ kind, t }) {
    return <div class="actions">
        <button id={`${kind}-save-btn`} type="submit" class="primary">{t.saveButton}</button>
        <button id={`${kind}-cancel-btn`} type="button">{t.cancelButton}</button>
    </div>;
}

function SourcesPanel({ t }) {
    return <section id="panel-sources" aria-labelledby="tab-sources">
        <div class="toolbar">
            <div><h1>{t.sourcesHeading}</h1><p class="muted">{t.sourcesDescription}</p></div>
            <button id="new-source-btn" type="button" class="primary">{t.newSourceButton}</button>
        </div>
        <form id="source-form" class="card editor" method="post" hidden>
            <input id="source-id" type="hidden" />
            <div class="fields">
                <label class="field">{t.aliasLabel}<input id="source-alias" type="text" required maxlength="80" /></label>
                <label class="field">{t.sourceUrlLabel}<input id="source-url" type="url" placeholder={t.sourceUrlPlaceholder} /></label>
                <label class="field">{t.inputFormatLabel}
                    <select id="source-format">{inputFormats.map(value => <option key={value} value={value}>{value}</option>)}</select>
                </label>
                <label class="field">{t.requestUaLabel}<input id="source-ua" type="text" placeholder="clash.meta" value="clash.meta" /></label>
            </div>
            <label class="check"><input id="source-enabled" type="checkbox" checked />{t.enabledLabel}</label>
            <FormActions kind="source" t={t} />
        </form>
        <div id="sources-list" class="item-list"></div>
    </section>;
}

function CollectionsPanel({ t }) {
    return <section id="panel-collections" aria-labelledby="tab-collections" hidden>
        <div class="toolbar">
            <h1>{t.collectionsHeading}</h1>
            <button id="new-collection-btn" type="button" class="primary">{t.newCollectionButton}</button>
        </div>
        <form id="collection-form" class="card editor" method="post" hidden>
            <input id="collection-id" type="hidden" />
            <div class="fields">
                <label class="field">{t.aliasLabel}<input id="collection-alias" type="text" required maxlength="80" /></label>
                <label class="field">{t.defaultTargetLabel}
                    <select id="collection-target">{outputTargets.map(value => <option key={value} value={value}>{value}</option>)}</select>
                </label>
                <label class="field">{t.cacheTtlLabel}
                    <input id="collection-cache-ttl" type="number" min="0" max="168" step="1" value="6" />
                </label>
            </div>
            <fieldset>
                <legend>{t.sourcesMergeLegend}</legend>
                <div id="collection-sources-picker"></div>
            </fieldset>
            <div class="actions">
                <label class="check"><input id="collection-prefix" type="checkbox" checked />{t.prefixEnabledLabel}</label>
                <label class="check"><input id="collection-dedup" type="checkbox" checked />{t.dedupEnabledLabel}</label>
                <label class="check"><input id="collection-enabled" type="checkbox" checked />{t.enabledLabel}</label>
            </div>
            <FormActions kind="collection" t={t} />
        </form>
        <div id="collections-list" class="item-list"></div>
    </section>;
}

function PreviewModal({ t }) {
    return <dialog id="preview-modal" aria-labelledby="preview-title" hidden>
        <div class="toolbar">
            <h2 id="preview-title">{t.previewTitle}</h2>
            <button id="preview-close-btn" type="button" autofocus>{t.closeButton}</button>
        </div>
        <p id="preview-summary" class="muted"></p>
        <ul id="preview-warnings" class="notice warning" hidden></ul>
        <div class="table-scroll">
            <table>
                <thead><tr><th>{t.tableColName}</th><th>{t.tableColType}</th><th>{t.tableColServerPort}</th><th>{t.tableColTls}</th><th>{t.tableColTransport}</th></tr></thead>
                <tbody id="preview-table-body"></tbody>
            </table>
        </div>
    </dialog>;
}

function AdminPage({ lang }) {
    const t = getHubTranslations(lang);
    const nextLang = lang === 'en-US' ? 'zh-CN' : 'en-US';
    const currentYear = new Date().getFullYear();
    return <Page title={`${APP_NAME} - ${t.adminPageTitle}`} page="admin" lang={lang}>
        <header class="topbar">
            <div class="shell topbar-content">
                <a href="/" class="brand">
                    <img src="/favicon.ico" alt={`${APP_NAME} logo`} class="brand-logo" />
                    <span>{APP_NAME}</span>
                </a>
                <nav class="tabs" aria-label={t.adminNavAria}>
                    <button id="tab-sources" type="button" aria-controls="panel-sources" aria-pressed="true">{t.sourcesTab}</button>
                    <button id="tab-collections" type="button" aria-controls="panel-collections" aria-pressed="false">{t.collectionsTab}</button>
                </nav>
                <div class="actions header-actions">
                    <a href="/" class="nav-pill">{t.converterLink}</a>
                    <button id="lang-toggle" type="button" data-next-lang={nextLang} aria-label={t.switchLangAria}>{t.switchLangLabel}</button>
                    <button id="theme-toggle" type="button" aria-pressed="false">{t.darkModeButton}</button>
                    <button id="logout-btn" type="button">{t.logoutButton}</button>
                </div>
            </div>
        </header>
        <main class="shell workspace">
            <p id="toast" class="notice" role="status" hidden></p>
            <SourcesPanel t={t} />
            <CollectionsPanel t={t} />
        </main>
        <footer class="hub-footer">
            <div class="shell footer-content">
                <div class="footer-meta">
                    <span>© {currentYear} {APP_NAME}. All rights reserved.</span>
                    <span class="footer-sep">|</span>
                    <a href={`${GITHUB_REPO}/releases/tag/v${APP_VERSION}`} target="_blank" rel="noopener noreferrer" class="version-pill">v{APP_VERSION}</a>
                </div>
                <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer" class="footer-link">GitHub</a>
            </div>
        </footer>
        <PreviewModal t={t} />
    </Page>;
}

export function mountHubPageRoutes(app) {
    app.get('/login', async c => {
        const { auth } = c.get('hub') || {};
        if (auth && await auth.validateSession(getSessionTokenFromRequest(c))) return c.redirect('/admin', 302);
        const lang = resolveHubLanguage(c);
        return c.html(html`<!doctype html>${<LoginPage configured={Boolean(auth)} lang={lang} />}`);
    });
    app.get('/admin', c => {
        const lang = resolveHubLanguage(c);
        return c.html(html`<!doctype html>${<AdminPage lang={lang} />}`);
    });
    app.get('/admin/*', c => c.redirect('/admin', 302));
}
