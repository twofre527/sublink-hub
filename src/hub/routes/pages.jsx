/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { html } from 'hono/html';
import { getSessionTokenFromRequest } from '../auth.js';

const inputFormats = ['auto', 'yaml', 'base64', 'uri', 'json', 'surge'];
const outputTargets = ['mihomo', 'base64', 'singbox', 'surge'];

function Page({ title, page, children }) {
    return <html lang="zh-CN">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex, nofollow" />
            <title>{title}</title>
            <link rel="stylesheet" href="/hub.css" />
            <script defer src="/hub.js"></script>
        </head>
        <body data-page={page}>{children}</body>
    </html>;
}

function LoginPage({ configured }) {
    return <Page title="Subscription Hub - 登录" page="login">
        <main class="card login-card">
            <h1>Subscription Hub</h1>
            <p class="muted">管理员登录</p>
            {!configured && <p class="notice error" role="alert">未配置 ADMIN_PASSWORD_HASH 或 HUB_DB，无法登录</p>}
            <form id="login-form" method="post" action="/api/hub/login">
                <label class="field">密码
                    <input id="password" type="password" name="password" required autocomplete="current-password" />
                </label>
                <label class="check"><input id="remember-me" type="checkbox" />记住我（30 天）</label>
                <p id="login-error" class="notice error" role="alert" hidden></p>
                <button type="submit" class="primary" disabled={!configured}>登录</button>
            </form>
        </main>
    </Page>;
}

function FormActions({ kind }) {
    return <div class="actions">
        <button id={`${kind}-save-btn`} type="submit" class="primary">保存</button>
        <button id={`${kind}-cancel-btn`} type="button">取消</button>
    </div>;
}

function SourcesPanel() {
    return <section id="panel-sources" aria-labelledby="tab-sources">
        <div class="toolbar">
            <div><h1>订阅源</h1><p class="muted">手动刷新可立即获取上游节点。</p></div>
            <button id="new-source-btn" type="button" class="primary">+ 新增订阅源</button>
        </div>
        <form id="source-form" class="card editor" method="post" hidden>
            <input id="source-id" type="hidden" />
            <div class="fields">
                <label class="field">别名<input id="source-alias" type="text" required maxlength="80" /></label>
                <label class="field">订阅链接<input id="source-url" type="url" placeholder="https://...（编辑时留空保持原链接）" /></label>
                <label class="field">输入格式
                    <select id="source-format">{inputFormats.map(value => <option key={value} value={value}>{value}</option>)}</select>
                </label>
                <label class="field">请求 User-Agent<input id="source-ua" type="text" placeholder="clash.meta" value="clash.meta" /></label>
            </div>
            <label class="check"><input id="source-enabled" type="checkbox" checked />启用</label>
            <FormActions kind="source" />
        </form>
        <div id="sources-list" class="item-list"></div>
    </section>;
}

function CollectionsPanel() {
    return <section id="panel-collections" aria-labelledby="tab-collections" hidden>
        <div class="toolbar">
            <h1>组合列表</h1>
            <button id="new-collection-btn" type="button" class="primary">+ 新增组合列表</button>
        </div>
        <form id="collection-form" class="card editor" method="post" hidden>
            <input id="collection-id" type="hidden" />
            <div class="fields">
                <label class="field">别名<input id="collection-alias" type="text" required maxlength="80" /></label>
                <label class="field">默认输出格式
                    <select id="collection-target">{outputTargets.map(value => <option key={value} value={value}>{value}</option>)}</select>
                </label>
            </div>
            <fieldset>
                <legend>订阅源与合并顺序</legend>
                <div id="collection-sources-picker"></div>
            </fieldset>
            <div class="actions">
                <label class="check"><input id="collection-prefix" type="checkbox" checked />添加来源别名前缀</label>
                <label class="check"><input id="collection-dedup" type="checkbox" checked />自动去重节点</label>
                <label class="check"><input id="collection-enabled" type="checkbox" checked />启用</label>
            </div>
            <FormActions kind="collection" />
        </form>
        <div id="collections-list" class="item-list"></div>
    </section>;
}

function PreviewModal() {
    return <dialog id="preview-modal" aria-labelledby="preview-title" hidden>
        <div class="toolbar">
            <h2 id="preview-title">节点预览</h2>
            <button id="preview-close-btn" type="button" autofocus>关闭</button>
        </div>
        <p id="preview-summary" class="muted"></p>
        <ul id="preview-warnings" class="notice warning" hidden></ul>
        <div class="table-scroll">
            <table>
                <thead><tr><th>名称</th><th>协议</th><th>服务器:端口</th><th>TLS</th><th>传输</th></tr></thead>
                <tbody id="preview-table-body"></tbody>
            </table>
        </div>
    </dialog>;
}

function AdminPage() {
    return <Page title="Subscription Hub - 管理" page="admin">
        <header class="topbar">
            <div class="shell topbar-content">
                <strong class="brand">Subscription Hub</strong>
                <nav class="tabs" aria-label="管理面板">
                    <button id="tab-sources" type="button" aria-controls="panel-sources" aria-pressed="true">订阅源</button>
                    <button id="tab-collections" type="button" aria-controls="panel-collections" aria-pressed="false">组合列表</button>
                </nav>
                <div class="actions header-actions">
                    <a href="/">单次转换</a>
                    <button id="theme-toggle" type="button" aria-pressed="false">深色模式</button>
                    <button id="logout-btn" type="button">退出登录</button>
                </div>
            </div>
        </header>
        <main class="shell workspace">
            <p id="toast" class="notice" role="status" hidden></p>
            <SourcesPanel />
            <CollectionsPanel />
        </main>
        <PreviewModal />
    </Page>;
}

export function mountHubPageRoutes(app) {
    app.get('/login', async c => {
        const { auth } = c.get('hub') || {};
        if (auth && await auth.validateSession(getSessionTokenFromRequest(c))) return c.redirect('/admin', 302);
        return c.html(html`<!doctype html>${<LoginPage configured={Boolean(auth)} />}`);
    });
    app.get('/admin', c => c.html(html`<!doctype html>${<AdminPage />}`));
    app.get('/admin/*', c => c.redirect('/admin', 302));
}
