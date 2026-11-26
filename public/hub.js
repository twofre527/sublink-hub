(function () {
    'use strict';

    const byId = id => document.getElementById(id);
    const pathFor = (group, id) => '/' + group + (id ? '/' + encodeURIComponent(id) : '');
    const lang = document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN';

    const i18n = {
        'zh-CN': {
            requestFailed: status => '请求失败（' + status + '）',
            lightMode: '浅色模式',
            darkMode: '深色模式',
            invalidCredentials: '密码有误，请重试。',
            statusNames: { ok: '正常', pending: '待刷新', error: '异常', disabled: '已停用' },
            previewTitleSuffix: ' · 节点预览',
            previewSummary: result => '共 ' + result.nodeCount + ' 个节点' + (
                result.dedupedCount === undefined
                    ? ' · 解析丢弃 ' + result.droppedCount + ' 个'
                    : ' · 合并前 ' + result.totalBeforeDedup + ' 个 · 去重 ' + result.dedupedCount + ' 个'
            ),
            tlsOn: '启用',
            tlsOff: '关闭',
            neverSucceeded: '尚未成功',
            nodeCount: count => count + ' 个节点',
            droppedCount: count => '丢弃 ' + count,
            lastSuccess: time => '最近成功: ' + time,
            edit: '编辑',
            refresh: '刷新',
            previewNodes: '预览节点',
            delete: '删除',
            noSources: '暂无订阅源。',
            refreshStale: warning => '刷新失败，已保留缓存节点：' + warning,
            sourceRefreshed: '订阅源已刷新。',
            sourceDeleted: '订阅源已删除。',
            sourceInUse: aliases => '请先从以下组合移除此订阅源：' + aliases.join('、'),
            sourceSavedWithWarning: err => '订阅源已保存，首次刷新失败：' + err,
            sourceSaved: '订阅源已保存。',
            moveUp: alias => '上移 ' + alias,
            moveDown: alias => '下移 ' + alias,
            addSourceFirst: '请先添加订阅源。',
            realtimeCache: '实时刷新',
            hoursCache: hours => hours + ' 小时缓存',
            collectionMeta: (sourceCount, nodeCount, target, cacheLabel) =>
                sourceCount + ' 个订阅源 · ' + nodeCount + ' 个节点 · ' + target + ' · ' + cacheLabel,
            disable: '停用',
            enable: '启用',
            collectionStatusUpdated: '组合状态已更新。',
            copyUrl: '复制链接',
            clipboardUnavailable: '当前环境不支持自动复制，请手动复制上方链接。',
            urlCopied: '链接已复制。',
            rotateToken: '重置链接',
            confirmRotateToken: '重置链接后旧链接将立即失效，确认继续？',
            newUrlGenerated: '新链接已生成。',
            confirmDeleteCollection: '确认删除此组合？',
            collectionDeleted: '组合已删除。',
            noCollections: '暂无组合。',
            collectionSaved: '组合已保存。'
        },
        'en-US': {
            requestFailed: status => 'Request failed (' + status + ')',
            lightMode: 'Light',
            darkMode: 'Dark',
            invalidCredentials: 'Invalid password. Please try again.',
            statusNames: { ok: 'OK', pending: 'Pending', error: 'Error', disabled: 'Disabled' },
            previewTitleSuffix: ' · Node Preview',
            previewSummary: result => result.nodeCount + ' nodes' + (
                result.dedupedCount === undefined
                    ? ' · ' + result.droppedCount + ' dropped'
                    : ' · ' + result.totalBeforeDedup + ' before dedup · ' + result.dedupedCount + ' deduped'
            ),
            tlsOn: 'On',
            tlsOff: 'Off',
            neverSucceeded: 'Never',
            nodeCount: count => count + ' nodes',
            droppedCount: count => count + ' dropped',
            lastSuccess: time => 'Last success: ' + time,
            edit: 'Edit',
            refresh: 'Refresh',
            previewNodes: 'Preview',
            delete: 'Delete',
            noSources: 'No sources yet.',
            refreshStale: warning => 'Refresh failed, retained cached nodes: ' + warning,
            sourceRefreshed: 'Source refreshed.',
            sourceDeleted: 'Source deleted.',
            sourceInUse: aliases => 'Remove this source from the following collections first: ' + aliases.join(', '),
            sourceSavedWithWarning: err => 'Source saved, initial refresh failed: ' + err,
            sourceSaved: 'Source saved.',
            moveUp: alias => 'Move up ' + alias,
            moveDown: alias => 'Move down ' + alias,
            addSourceFirst: 'Please add a source first.',
            realtimeCache: 'Real-time',
            hoursCache: hours => hours + 'h cache',
            collectionMeta: (sourceCount, nodeCount, target, cacheLabel) =>
                sourceCount + ' sources · ' + nodeCount + ' nodes · ' + target + ' · ' + cacheLabel,
            disable: 'Disable',
            enable: 'Enable',
            collectionStatusUpdated: 'Collection status updated.',
            copyUrl: 'Copy URL',
            clipboardUnavailable: 'Clipboard unavailable. Please copy the URL above manually.',
            urlCopied: 'URL copied.',
            rotateToken: 'Rotate Token',
            confirmRotateToken: 'Rotating the token will invalidate the old URL immediately. Continue?',
            newUrlGenerated: 'New URL generated.',
            confirmDeleteCollection: 'Delete this collection?',
            collectionDeleted: 'Collection deleted.',
            noCollections: 'No collections yet.',
            collectionSaved: 'Collection saved.'
        }
    };
    const t = i18n[lang];

    function el(tag, attrs, children) {
        const element = document.createElement(tag);
        Object.keys(attrs || {}).forEach(key => element.setAttribute(key, attrs[key]));
        if (Array.isArray(children)) children.forEach(child => element.appendChild(child));
        else if (children !== undefined) element.textContent = children;
        return element;
    }

    function api(path, method, body) {
        const headers = { Accept: 'application/json' };
        const options = {
            method: method || 'GET',
            credentials: 'same-origin',
            headers
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        return fetch('/api/hub' + path, options).then(response => {
            // The login page already provides the destination and can show a rejected password.
            if (response.status === 401 && location.pathname !== '/login') location.replace('/login');
            return response.json().catch(() => ({})).then(data => {
                if (response.ok) return data;
                const error = new Error(data.error ? data.error.message : t.requestFailed(response.status));
                error.status = response.status;
                error.code = data.error && data.error.code;
                error.data = data;
                throw error;
            });
        });
    }

    function notice(element, message, tone) {
        element.textContent = message;
        element.className = 'notice ' + tone;
        element.hidden = false;
    }

    function button(label, action, className) {
        const element = el('button', { type: 'button' }, label);
        if (className) element.className = className;
        element.addEventListener('click', action);
        return element;
    }

    function initTheme() {
        const root = document.documentElement;
        const system = window.matchMedia('(prefers-color-scheme: dark)');
        const toggle = byId('theme-toggle');
        const current = () => root.dataset.theme || (system.matches ? 'dark' : 'light');
        const update = () => {
            if (!toggle) return;
            const isDark = current() === 'dark';
            toggle.setAttribute('aria-pressed', String(isDark));
            toggle.textContent = isDark ? t.lightMode : t.darkMode;
        };
        const saved = localStorage.getItem('theme') || localStorage.getItem('hub_theme');
        if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
        if (toggle) toggle.addEventListener('click', () => {
            root.dataset.theme = current() === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', root.dataset.theme);
            localStorage.removeItem('hub_theme');
            update();
        });
        system.addEventListener('change', update);
        update();
    }

    function initLangToggle() {
        const toggle = byId('lang-toggle');
        if (!toggle) return;
        toggle.addEventListener('click', () => {
            const nextLang = toggle.dataset.nextLang || (lang === 'en-US' ? 'zh-CN' : 'en-US');
            document.cookie = 'hub_lang=' + nextLang + '; Path=/; SameSite=Lax; Max-Age=31536000';
            // Strip ?lang= so the newly persisted cookie takes precedence on reload.
            const url = new URL(location.href);
            if (url.searchParams.has('lang')) {
                url.searchParams.delete('lang');
                location.replace(url.toString());
            } else {
                location.reload();
            }
        });
    }

    function initLogin() {
        byId('login-form').addEventListener('submit', event => {
            event.preventDefault();
            byId('login-error').hidden = true;
            api('/login', 'POST', {
                password: byId('password').value,
                rememberMe: byId('remember-me').checked
            }).then(() => location.replace('/admin')).catch(error => notice(
                byId('login-error'), error.code === 'INVALID_CREDENTIALS' ? t.invalidCredentials : error.message, 'error'
            ));
        });
    }

    function fillList(container, cards, emptyText) {
        container.replaceChildren(...(cards.length ? cards : [el('p', { class: 'muted' }, emptyText)]));
    }

    const badge = status => el('span', { class: 'badge ' + status }, t.statusNames[status]);
    const actionRow = actions => el('div', { class: 'actions' }, actions);
    const warningsList = warnings => el('ul', { class: 'notice warning' }, warnings.map(text => el('li', {}, text)));

    function initAdmin() {
        const sourceForm = byId('source-form');
        const collectionForm = byId('collection-form');
        const modal = byId('preview-modal');
        let sources = [];
        let selected = [];

        const show = (message, tone) => notice(byId('toast'), message, tone || 'ok');
        const fail = error => show(error.message, 'error');

        function switchTab(group) {
            ['sources', 'collections'].forEach(tab => {
                byId('panel-' + tab).hidden = tab !== group;
                byId('tab-' + tab).setAttribute('aria-pressed', String(tab === group));
            });
            return (group === 'sources' ? loadSources() : Promise.all([loadSources(), loadCollections()])).catch(fail);
        }

        function preview(path) {
            api(path + '/nodes').then(result => {
                const warnings = result.warnings || result.diagnostics || [];
                byId('preview-title').textContent = result.alias + t.previewTitleSuffix;
                byId('preview-summary').textContent = t.previewSummary(result);
                byId('preview-warnings').replaceChildren(...warnings.map(text => el('li', {}, text)));
                byId('preview-warnings').hidden = warnings.length === 0;
                byId('preview-table-body').replaceChildren(...result.nodes.map(node => {
                    const server = node.server.indexOf(':') !== -1 && !node.server.startsWith('[') ? '[' + node.server + ']' : node.server;
                    const fields = [node.tag, node.type, server + ':' + node.port, node.tls ? t.tlsOn : t.tlsOff, node.transport];
                    return el('tr', {}, fields.map(value => el('td', {}, value)));
                }));
                modal.hidden = false;
                modal.showModal();
            }).catch(fail);
        }

        function openSource(source) {
            sourceForm.reset();
            byId('source-id').value = source ? source.id : '';
            byId('source-url').required = !source;
            if (source) {
                byId('source-alias').value = source.alias;
                byId('source-format').value = source.inputFormat;
                byId('source-ua').value = source.requestUA;
                byId('source-enabled').checked = source.enabled;
            }
            sourceForm.hidden = false;
            byId('source-alias').focus();
        }

        function formatTime(ms) {
            return ms ? new Date(ms).toLocaleString(lang) : t.neverSucceeded;
        }

        function renderSources() {
            fillList(byId('sources-list'), sources.map(source => {
                const path = pathFor('sources', source.id);
                const meta = [
                    t.nodeCount(source.nodeCount),
                    source.droppedCount > 0 ? t.droppedCount(source.droppedCount) : null,
                    source.inputFormat,
                    t.lastSuccess(formatTime(source.lastSuccessAt))
                ].filter(Boolean).join(' · ');
                const children = [
                    el('div', { class: 'item-header' }, [el('h2', {}, source.alias), badge(source.enabled ? source.status : 'disabled')]),
                    el('code', { class: 'url' }, source.maskedUrl),
                    el('p', { class: 'muted' }, meta)
                ];
                if (source.lastError) children.push(el('p', { class: 'notice error' }, source.lastError));
                children.push(actionRow([
                    button(t.edit, () => openSource(source)),
                    button(t.refresh, () => refreshSource(path)),
                    button(t.previewNodes, () => preview(path)),
                    button(t.delete, () => removeSource(path), 'danger')
                ]));
                return el('article', { class: 'card item' }, children);
            }), t.noSources);
        }

        function loadSources() {
            return api('/sources').then(result => {
                sources = result.sources;
                renderSources();
                if (!collectionForm.hidden) {
                    const ids = new Set(sources.map(source => source.id));
                    selected = selected.filter(id => ids.has(id));
                    renderPicker();
                }
            });
        }

        function refreshSource(path) {
            const update = source => {
                sources = sources.map(item => item.id === source.id ? source : item);
                renderSources();
            };
            api(path + '/refresh', 'POST').then(result => {
                update(result.source);
                if (result.staleRetained) show(t.refreshStale(result.warning), 'warning');
                else show(t.sourceRefreshed);
            }).catch(error => {
                if (error.status === 502 && error.data.source) update(error.data.source);
                fail(error);
            });
        }

        function removeSource(path) {
            api(path, 'DELETE').then(loadSources).then(() => show(t.sourceDeleted)).catch(error => {
                if (error.status === 409 && error.code === 'SOURCE_IN_USE') {
                    show(t.sourceInUse(error.data.collections.map(collection => collection.alias)), 'error');
                } else fail(error);
            });
        }

        function saveSource(event) {
            event.preventDefault();
            const id = byId('source-id').value;
            const url = byId('source-url').value.trim();
            const payload = {
                alias: byId('source-alias').value,
                inputFormat: byId('source-format').value,
                requestUA: byId('source-ua').value,
                enabled: byId('source-enabled').checked
            };
            if (url || !id) payload.url = url;
            const saveBtn = byId('source-save-btn');
            saveBtn.disabled = true;
            api(pathFor('sources', id), id ? 'PUT' : 'POST', payload).then(result => {
                sourceForm.hidden = true;
                return loadSources().then(() => {
                    if (!id && result.source.status === 'error') show(t.sourceSavedWithWarning(result.source.lastError), 'warning');
                    else show(t.sourceSaved);
                });
            }).catch(fail).finally(() => { saveBtn.disabled = false; });
        }

        function renderPicker(focusId, focusControl) {
            const ids = selected.concat(sources.map(source => source.id).filter(id => selected.indexOf(id) === -1));
            let focus;
            const rows = ids.map(id => {
                const source = sources.find(item => item.id === id);
                if (!source) return null;
                const index = selected.indexOf(id);
                const checkbox = el('input', { type: 'checkbox' });
                checkbox.checked = index !== -1;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.push(id);
                    else selected.splice(index, 1);
                    renderPicker(id, 'checkbox');
                });
                const controls = [checkbox];
                const children = [el('label', { class: 'check' }, [checkbox, el('span', {}, source.alias)])];
                if (checkbox.checked) {
                    const move = delta => {
                        selected.splice(index, 1);
                        selected.splice(index + delta, 0, id);
                        renderPicker(id, delta < 0 ? 'up' : 'down');
                    };
                    const up = button('↑', () => move(-1));
                    const down = button('↓', () => move(1));
                    up.disabled = index === 0;
                    down.disabled = index === selected.length - 1;
                    up.setAttribute('aria-label', t.moveUp(source.alias));
                    down.setAttribute('aria-label', t.moveDown(source.alias));
                    controls.push(up, down);
                    children.push(actionRow([up, down]));
                }
                if (id === focusId) {
                    const control = controls[['checkbox', 'up', 'down'].indexOf(focusControl)];
                    focus = control.disabled ? checkbox : control;
                }
                return el('div', { class: 'picker-row' }, children);
            }).filter(Boolean);
            fillList(byId('collection-sources-picker'), rows, t.addSourceFirst);
            if (focus) focus.focus();
        }

        function openCollection(collection) {
            collectionForm.reset();
            byId('collection-id').value = collection ? collection.id : '';
            selected = collection ? collection.sourceIds.slice() : [];
            if (collection) {
                byId('collection-alias').value = collection.alias;
                byId('collection-prefix').checked = collection.prefixEnabled;
                byId('collection-dedup').checked = collection.deduplicate;
                byId('collection-target').value = collection.defaultTarget;
                byId('collection-cache-ttl').value = String(collection.cacheTtlHours !== null && collection.cacheTtlHours !== undefined ? collection.cacheTtlHours : 6);
                byId('collection-enabled').checked = collection.enabled;
            } else {
                byId('collection-cache-ttl').value = '6';
            }
            renderPicker();
            collectionForm.hidden = false;
            byId('collection-alias').focus();
        }

        function collectionCard(collection) {
            const path = pathFor('collections', collection.id);
            const url = location.origin + collection.subscriptionPath;
            const formats = [
                ['Mihomo', 'mihomo'], ['Mihomo Provider', 'mihomo&mode=provider'],
                ['Base64', 'base64'], ['Sing-Box', 'singbox'], ['Surge', 'surge']
            ];
            const cacheLabel = collection.cacheTtlHours === 0
                ? t.realtimeCache
                : t.hoursCache(collection.cacheTtlHours !== null && collection.cacheTtlHours !== undefined ? collection.cacheTtlHours : 6);
            const children = [
                el('div', { class: 'item-header' }, [el('h2', {}, collection.alias), badge(collection.enabled ? 'ok' : 'disabled')]),
                el('p', { class: 'muted' }, t.collectionMeta(collection.sourceIds.length, collection.mergedNodeCount, collection.defaultTarget, cacheLabel)),
                el('code', { class: 'url' }, url),
                el('div', { class: 'actions quick-links' }, formats.map(format => el('a', {
                    href: url + '?target=' + format[1],
                    target: '_blank',
                    rel: 'noopener noreferrer'
                }, format[0])))
            ];
            if (collection.warnings.length) children.push(warningsList(collection.warnings));
            children.push(actionRow([
                button(t.edit, () => openCollection(collection)),
                button(collection.enabled ? t.disable : t.enable, () => changeCollection(path, 'PUT', t.collectionStatusUpdated, { enabled: !collection.enabled })),
                button(t.copyUrl, () => {
                    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                        show(t.clipboardUnavailable, 'warning');
                        return;
                    }
                    navigator.clipboard.writeText(url).then(() => show(t.urlCopied)).catch(fail);
                }),
                button(t.previewNodes, () => preview(path)),
                button(t.rotateToken, () => {
                    if (window.confirm(t.confirmRotateToken)) changeCollection(path + '/rotate-token', 'POST', t.newUrlGenerated);
                }),
                button(t.delete, () => {
                    if (window.confirm(t.confirmDeleteCollection)) changeCollection(path, 'DELETE', t.collectionDeleted);
                }, 'danger')
            ]));
            return el('article', { class: 'card item' }, children);
        }

        function loadCollections() {
            return api('/collections').then(result => fillList(
                byId('collections-list'), result.collections.map(collectionCard), t.noCollections
            ));
        }

        function changeCollection(path, method, message, payload) {
            api(path, method, payload).then(loadCollections).then(() => show(message)).catch(fail);
        }

        function saveCollection(event) {
            event.preventDefault();
            const id = byId('collection-id').value;
            const saveBtn = byId('collection-save-btn');
            saveBtn.disabled = true;
            const rawTtl = byId('collection-cache-ttl').value.trim();
            const cacheTtlHours = rawTtl === '' ? null : Number(rawTtl);
            api(pathFor('collections', id), id ? 'PUT' : 'POST', {
                alias: byId('collection-alias').value,
                sourceIds: selected.slice(),
                prefixEnabled: byId('collection-prefix').checked,
                deduplicate: byId('collection-dedup').checked,
                defaultTarget: byId('collection-target').value,
                cacheTtlHours,
                enabled: byId('collection-enabled').checked
            }).then(() => {
                collectionForm.hidden = true;
                return loadCollections();
            }).then(() => show(t.collectionSaved)).catch(fail).finally(() => { saveBtn.disabled = false; });
        }

        byId('tab-sources').addEventListener('click', () => switchTab('sources'));
        byId('tab-collections').addEventListener('click', () => switchTab('collections'));
        byId('logout-btn').addEventListener('click', () => api('/logout', 'POST').then(() => location.replace('/login')).catch(fail));
        byId('new-source-btn').addEventListener('click', () => openSource());
        byId('source-cancel-btn').addEventListener('click', () => { sourceForm.hidden = true; });
        sourceForm.addEventListener('submit', saveSource);
        byId('new-collection-btn').addEventListener('click', () => openCollection());
        byId('collection-cancel-btn').addEventListener('click', () => { collectionForm.hidden = true; });
        collectionForm.addEventListener('submit', saveCollection);
        byId('preview-close-btn').addEventListener('click', () => modal.close());
        modal.addEventListener('close', () => { modal.hidden = true; });
        switchTab('sources');
    }

    initTheme();
    initLangToggle();
    if (document.body.dataset.page === 'login') initLogin();
    else if (document.body.dataset.page === 'admin') initAdmin();
}());
