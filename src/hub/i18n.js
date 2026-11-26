import { parseCookies } from './auth.js';

export const HUB_LANG_COOKIE_NAME = 'hub_lang';

const hubTranslations = {
    'zh-CN': {
        loginPageTitle: '登录',
        adminPageTitle: '管理',
        loginSubtitle: '管理员登录',
        notConfiguredError: '未配置 ADMIN_PASSWORD_HASH 或 HUB_DB，无法登录',
        passwordLabel: '密码',
        rememberMeLabel: '记住我（30 天）',
        loginButton: '登录',
        saveButton: '保存',
        cancelButton: '取消',
        sourcesTab: '订阅源',
        collectionsTab: '组合列表',
        sourcesHeading: '订阅源',
        sourcesDescription: '手动刷新可立即获取上游节点。',
        newSourceButton: '+ 新增订阅源',
        aliasLabel: '别名',
        sourceUrlLabel: '订阅链接',
        sourceUrlPlaceholder: 'https://...（编辑时留空保持原链接）',
        inputFormatLabel: '输入格式',
        requestUaLabel: '请求 User-Agent',
        enabledLabel: '启用',
        collectionsHeading: '组合列表',
        newCollectionButton: '+ 新增组合列表',
        defaultTargetLabel: '默认输出格式',
        cacheTtlLabel: '缓存时长（小时，0 为每次实时刷新）',
        sourcesMergeLegend: '订阅源与合并顺序',
        prefixEnabledLabel: '添加来源别名前缀',
        dedupEnabledLabel: '自动去重节点',
        previewTitle: '节点预览',
        closeButton: '关闭',
        tableColName: '名称',
        tableColType: '协议',
        tableColServerPort: '服务器:端口',
        tableColTls: 'TLS',
        tableColTransport: '传输',
        adminNavAria: '管理面板',
        converterLink: '单次转换',
        darkModeButton: '深色模式',
        logoutButton: '退出登录',
        switchLangLabel: 'EN',
        switchLangAria: 'Switch to English'
    },
    'en-US': {
        loginPageTitle: 'Login',
        adminPageTitle: 'Admin',
        loginSubtitle: 'Admin Login',
        notConfiguredError: 'ADMIN_PASSWORD_HASH or HUB_DB is not configured. Login is unavailable.',
        passwordLabel: 'Password',
        rememberMeLabel: 'Remember me (30 days)',
        loginButton: 'Login',
        saveButton: 'Save',
        cancelButton: 'Cancel',
        sourcesTab: 'Sources',
        collectionsTab: 'Collections',
        sourcesHeading: 'Sources',
        sourcesDescription: 'Manual refresh fetches upstream nodes immediately.',
        newSourceButton: '+ Add Source',
        aliasLabel: 'Alias',
        sourceUrlLabel: 'Subscription URL',
        sourceUrlPlaceholder: 'https://... (leave blank when editing to keep existing URL)',
        inputFormatLabel: 'Input Format',
        requestUaLabel: 'Request User-Agent',
        enabledLabel: 'Enabled',
        collectionsHeading: 'Collections',
        newCollectionButton: '+ Add Collection',
        defaultTargetLabel: 'Default Target',
        cacheTtlLabel: 'Cache TTL (hours, 0 = always refresh)',
        sourcesMergeLegend: 'Sources & Merge Order',
        prefixEnabledLabel: 'Prefix node names with source alias',
        dedupEnabledLabel: 'Deduplicate nodes',
        previewTitle: 'Node Preview',
        closeButton: 'Close',
        tableColName: 'Name',
        tableColType: 'Type',
        tableColServerPort: 'Server:Port',
        tableColTls: 'TLS',
        tableColTransport: 'Transport',
        adminNavAria: 'Admin Panel',
        converterLink: 'Converter',
        darkModeButton: 'Dark',
        logoutButton: 'Logout',
        switchLangLabel: '中文',
        switchLangAria: '切换到中文'
    }
};

export function normalizeHubLanguage(lang) {
    if (typeof lang !== 'string') return 'zh-CN';
    const trimmed = lang.trim().toLowerCase();
    return trimmed.startsWith('en') ? 'en-US' : 'zh-CN';
}

export function resolveHubLanguage(c) {
    const queryLang = c.req.query('lang');
    const cookieLang = parseCookies(c.req.header('Cookie'))[HUB_LANG_COOKIE_NAME];
    const acceptLanguage = c.req.header('Accept-Language')?.split(',')[0];
    return normalizeHubLanguage(queryLang || cookieLang || acceptLanguage || 'zh-CN');
}

export function getHubTranslations(lang) {
    return hubTranslations[normalizeHubLanguage(lang)];
}
