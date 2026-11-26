CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    url TEXT NOT NULL,
    input_format TEXT NOT NULL DEFAULT 'auto',
    request_ua TEXT NOT NULL DEFAULT 'clash.meta',
    enabled INTEGER NOT NULL DEFAULT 1,
    nodes_json TEXT,
    node_count INTEGER NOT NULL DEFAULT 0,
    dropped_count INTEGER NOT NULL DEFAULT 0,
    diagnostics_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    cache_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    source_ids_json TEXT NOT NULL DEFAULT '[]',
    prefix_enabled INTEGER NOT NULL DEFAULT 1,
    deduplicate INTEGER NOT NULL DEFAULT 1,
    default_target TEXT NOT NULL DEFAULT 'mihomo',
    enabled INTEGER NOT NULL DEFAULT 1,
    token TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_token_hash ON collections(token_hash);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL
);
