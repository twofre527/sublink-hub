import { createFieldCipher, randomBase64Url, sha256Hex } from './crypto.js';

const urlAad = id => `source:${id}:url`;
const tokenAad = id => `collection:${id}:token`;
const arrayFromJson = value => JSON.parse(value ?? '[]');

async function readSource(row, cipher) {
    return row ? {
        id: row.id, alias: row.alias, url: await cipher.decrypt(row.url, urlAad(row.id)),
        inputFormat: row.input_format, requestUA: row.request_ua, enabled: Boolean(row.enabled),
        nodes: arrayFromJson(row.nodes_json), nodeCount: row.node_count, droppedCount: row.dropped_count,
        diagnostics: arrayFromJson(row.diagnostics_json), status: row.status, lastError: row.last_error,
        lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, cacheVersion: row.cache_version,
        createdAt: row.created_at, updatedAt: row.updated_at
    } : null;
}

async function readCollection(row, cipher) {
    return row ? {
        id: row.id, alias: row.alias, sourceIds: arrayFromJson(row.source_ids_json),
        prefixEnabled: Boolean(row.prefix_enabled), deduplicate: Boolean(row.deduplicate),
        defaultTarget: row.default_target, enabled: Boolean(row.enabled),
        token: await cipher.decrypt(row.token, tokenAad(row.id)), tokenVersion: row.token_version,
        createdAt: row.created_at, updatedAt: row.updated_at
    } : null;
}

async function tokenFields(id, cipher) {
    const token = randomBase64Url(32);
    return { token: await cipher.encrypt(token, tokenAad(id)), token_hash: await sha256Hex(token) };
}

function createRepo(store, cipher) {
    const source = row => readSource(row, cipher);
    const collection = row => readCollection(row, cipher);
    return {
        async listSources() {
            return Promise.all((await store.list('sources')).map(source));
        },
        async getSource(id) {
            return source(await store.find('sources', 'id', id));
        },
        async createSource({ alias, url, inputFormat = 'auto', requestUA = 'clash.meta', enabled = true }) {
            const id = crypto.randomUUID();
            const now = Date.now();
            const row = {
                id, alias, url: await cipher.encrypt(url, urlAad(id)), input_format: inputFormat,
                request_ua: requestUA, enabled: Number(enabled), nodes_json: null, node_count: 0,
                dropped_count: 0, diagnostics_json: null, status: 'pending', last_error: null,
                last_attempt_at: null, last_success_at: null, cache_version: 0, created_at: now, updated_at: now
            };
            await store.insert('sources', row);
            return source(row);
        },
        async updateSource(id, { alias, url, inputFormat, requestUA, enabled }) {
            const fields = { updated_at: Date.now() };
            if (alias !== undefined) fields.alias = alias;
            if (url !== undefined) fields.url = await cipher.encrypt(url, urlAad(id));
            if (inputFormat !== undefined) fields.input_format = inputFormat;
            if (requestUA !== undefined) fields.request_ua = requestUA;
            if (enabled !== undefined) fields.enabled = Number(enabled);
            return source(await store.update('sources', id, fields));
        },
        async saveSourceRefreshSuccess(id, { nodes, droppedCount = 0, diagnostics = [], attemptedAt = Date.now(), expectedVersion }) {
            const row = await store.update('sources', id, {
                nodes_json: JSON.stringify(nodes), node_count: nodes.length, dropped_count: droppedCount,
                diagnostics_json: JSON.stringify(diagnostics), status: 'ok', last_error: null,
                last_attempt_at: attemptedAt, last_success_at: attemptedAt, updated_at: Date.now()
            }, 'cache_version', expectedVersion);
            if (row) return { updated: true, source: await source(row) };
            return { updated: false, conflict: expectedVersion !== undefined && Boolean(await store.find('sources', 'id', id)) };
        },
        async saveSourceRefreshFailure(id, { error, attemptedAt = Date.now() }) {
            return source(await store.update('sources', id, {
                status: 'error', last_error: String(error), last_attempt_at: attemptedAt, updated_at: Date.now()
            }));
        },
        async deleteSource(id) {
            if (await store.removeSource(id)) return { deleted: true };
            const referencedBy = await store.references(id);
            return referencedBy.length ? { deleted: false, referencedBy } : { deleted: false, notFound: true };
        },
        async listCollections() {
            return Promise.all((await store.list('collections')).map(collection));
        },
        async getCollection(id) {
            return collection(await store.find('collections', 'id', id));
        },
        async getCollectionByTokenHash(tokenHash) {
            return collection(await store.find('collections', 'token_hash', tokenHash));
        },
        async createCollection({ alias, sourceIds = [], prefixEnabled = true, deduplicate = true, defaultTarget = 'mihomo', enabled = true }) {
            const id = crypto.randomUUID();
            const now = Date.now();
            const row = {
                id, alias, source_ids_json: JSON.stringify(sourceIds), prefix_enabled: Number(prefixEnabled),
                deduplicate: Number(deduplicate), default_target: defaultTarget, enabled: Number(enabled),
                ...await tokenFields(id, cipher), token_version: 1, created_at: now, updated_at: now
            };
            await store.insert('collections', row);
            return collection(row);
        },
        async updateCollection(id, { alias, sourceIds, prefixEnabled, deduplicate, defaultTarget, enabled }) {
            const fields = { updated_at: Date.now() };
            if (alias !== undefined) fields.alias = alias;
            if (sourceIds !== undefined) fields.source_ids_json = JSON.stringify(sourceIds);
            if (prefixEnabled !== undefined) fields.prefix_enabled = Number(prefixEnabled);
            if (deduplicate !== undefined) fields.deduplicate = Number(deduplicate);
            if (defaultTarget !== undefined) fields.default_target = defaultTarget;
            if (enabled !== undefined) fields.enabled = Number(enabled);
            return collection(await store.update('collections', id, fields));
        },
        async rotateCollectionToken(id) {
            const fields = { ...await tokenFields(id, cipher), updated_at: Date.now() };
            return collection(await store.update('collections', id, fields, 'token_version'));
        },
        async deleteCollection(id) {
            return store.remove('collections', 'id', id);
        },
        async createSession(tokenHash, expiresAt, now = Date.now()) {
            await store.insert('sessions', { token_hash: tokenHash, expires_at: expiresAt, created_at: now });
        },
        async getSession(tokenHash, now = Date.now()) {
            const row = await store.find('sessions', 'token_hash', tokenHash);
            if (!row) return null;
            if (row.expires_at <= now) {
                await store.remove('sessions', 'token_hash', tokenHash);
                return null;
            }
            return { tokenHash: row.token_hash, expiresAt: row.expires_at, createdAt: row.created_at };
        },
        async deleteSession(tokenHash) {
            await store.remove('sessions', 'token_hash', tokenHash);
        },
        async purgeExpiredSessions(now = Date.now()) {
            await store.purge(now);
        },
        async getLoginRateLimit(ip, { now = Date.now(), maxAttempts = 5 } = {}) {
            const row = await store.find('login_attempts', 'ip', ip);
            const active = row && now < row.reset_at;
            const count = active ? row.count : 0;
            return { blocked: count >= maxAttempts, remaining: Math.max(0, maxAttempts - count), resetAt: active ? row.reset_at : null };
        },
        async recordLoginFailure(ip, { now = Date.now(), windowMs = 15 * 60 * 1000, maxAttempts = 5 } = {}) {
            const row = await store.recordFailure(ip, now, now + windowMs);
            return { count: row.count, blocked: row.count >= maxAttempts, resetAt: row.reset_at };
        },
        async clearLoginFailures(ip) {
            await store.remove('login_attempts', 'ip', ip);
        }
    };
}

export function createD1HubRepo(db, { cipher = createFieldCipher(null) } = {}) {
    const refQuery = 'SELECT c.id, c.alias FROM collections c WHERE EXISTS (SELECT 1 FROM json_each(c.source_ids_json) WHERE value = ?)';
    return createRepo({
        async list(table) {
            return (await db.prepare(`SELECT * FROM ${table} ORDER BY created_at, alias`).all()).results;
        },
        find(table, column, value) {
            return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).bind(value).first();
        },
        insert(table, row) {
            const columns = Object.keys(row);
            return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
                .bind(...Object.values(row)).run();
        },
        update(table, id, fields, increment, expectedVersion) {
            const sets = Object.keys(fields).map(column => `${column} = ?`);
            if (increment) sets.push(`${increment} = ${increment} + 1`);
            const checkVersion = expectedVersion !== undefined;
            const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?${checkVersion ? ' AND cache_version = ?' : ''} RETURNING *`;
            return db.prepare(sql).bind(...Object.values(fields), id, ...(checkVersion ? [expectedVersion] : [])).first();
        },
        async remove(table, column, value) {
            const result = await db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(value).run();
            return result.meta.changes > 0;
        },
        async removeSource(id) {
            const result = await db.prepare(`DELETE FROM sources WHERE id = ? AND NOT EXISTS (${refQuery})`).bind(id, id).run();
            return result.meta.changes > 0;
        },
        async references(id) {
            return (await db.prepare(`${refQuery} ORDER BY c.created_at, c.alias`).bind(id).all()).results;
        },
        purge(now) {
            return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
        },
        recordFailure(ip, now, resetAt) {
            return db.prepare(`INSERT INTO login_attempts (ip, count, reset_at) VALUES (?, 1, ?)
                ON CONFLICT(ip) DO UPDATE SET
                    count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                    reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
                RETURNING count, reset_at`).bind(ip, resetAt, now, now).first();
        }
    }, cipher);
}

export function createMemoryHubRepo({ cipher = createFieldCipher(null) } = {}) {
    const tables = { sources: new Map(), collections: new Map(), sessions: new Map(), login_attempts: new Map() };
    const list = table => Array.from(tables[table].values()).sort((a, b) =>
        a.created_at - b.created_at || (a.alias < b.alias ? -1 : Number(a.alias > b.alias)));
    const references = id => list('collections').filter(row => arrayFromJson(row.source_ids_json).includes(id))
        .map(({ id, alias }) => ({ id, alias }));
    return createRepo({
        list, references,
        find(table, column, value) {
            if (table === 'collections' && column === 'token_hash') {
                return Array.from(tables.collections.values()).find(row => row.token_hash === value);
            }
            return tables[table].get(value);
        },
        insert(table, row) {
            tables[table].set(row.id ?? row.token_hash, row);
        },
        update(table, id, fields, increment, expectedVersion) {
            const row = tables[table].get(id);
            if (!row || (expectedVersion !== undefined && row.cache_version !== expectedVersion)) return null;
            const updated = { ...row, ...fields };
            if (increment) updated[increment]++;
            tables[table].set(id, updated);
            return updated;
        },
        remove(table, column, value) {
            return tables[table].delete(value);
        },
        removeSource(id) {
            return references(id).length === 0 && tables.sources.delete(id);
        },
        purge(now) {
            for (const [key, row] of tables.sessions) {
                if (row.expires_at <= now) tables.sessions.delete(key);
            }
        },
        recordFailure(ip, now, resetAt) {
            const prev = tables.login_attempts.get(ip);
            const row = prev && prev.reset_at > now
                ? { count: prev.count + 1, reset_at: prev.reset_at }
                : { count: 1, reset_at: resetAt };
            tables.login_attempts.set(ip, row);
            return row;
        }
    }, cipher);
}
