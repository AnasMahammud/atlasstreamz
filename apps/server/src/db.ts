import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { config } from './config.ts';

/**
 * Versioned schema migrations. Append only: never edit a migration that has shipped.
 * Content IDs are stable strings (`provider:kind:sourceId`), never list positions.
 */
const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    profile_id TEXT,
    user_agent TEXT
  );
  CREATE TABLE auth_attempts (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    pin_hash TEXT,
    is_kids INTEGER NOT NULL DEFAULT 0,
    prefs_json TEXT NOT NULL DEFAULT '{}',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('xtream','m3u')),
    secret_enc TEXT NOT NULL,
    display_host TEXT NOT NULL,
    is_https INTEGER NOT NULL,
    http_consent INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_sync INTEGER NOT NULL DEFAULT 1,
    epg_url_enc TEXT,
    account_json TEXT,
    last_success_at INTEGER,
    last_attempt_at INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    trigger TEXT NOT NULL,
    summary_json TEXT,
    error TEXT
  );
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    genre TEXT,
    region TEXT,
    is_adult INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    item_count INTEGER NOT NULL DEFAULT 0,
    seen_run INTEGER NOT NULL
  );
  CREATE INDEX categories_kind ON categories(provider_id, kind, sort);
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    logo TEXT,
    category_id TEXT,
    number INTEGER,
    epg_id TEXT,
    catchup_days INTEGER,
    quality_hint TEXT,
    region TEXT,
    is_adult INTEGER NOT NULL DEFAULT 0,
    match_key TEXT NOT NULL,
    added_at INTEGER,
    url TEXT,
    options_json TEXT,
    alternates_json TEXT,
    seen_run INTEGER NOT NULL
  );
  CREATE INDEX channels_cat ON channels(category_id, number);
  CREATE INDEX channels_epg ON channels(epg_id);
  CREATE INDEX channels_match ON channels(provider_id, match_key);
  CREATE TABLE movies (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    poster TEXT,
    backdrop TEXT,
    plot TEXT,
    genres TEXT,
    cast_names TEXT,
    director TEXT,
    runtime_min INTEGER,
    rating REAL,
    tmdb_id TEXT,
    trailer TEXT,
    category_id TEXT,
    container TEXT,
    quality_hint TEXT,
    region TEXT,
    is_adult INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER,
    match_key TEXT NOT NULL,
    url TEXT,
    details_json TEXT,
    details_at INTEGER,
    seen_run INTEGER NOT NULL
  );
  CREATE INDEX movies_cat ON movies(category_id, added_at DESC);
  CREATE INDEX movies_added ON movies(added_at DESC);
  CREATE INDEX movies_match ON movies(provider_id, match_key);
  CREATE TABLE series (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    poster TEXT,
    backdrop TEXT,
    plot TEXT,
    genres TEXT,
    cast_names TEXT,
    director TEXT,
    rating REAL,
    tmdb_id TEXT,
    trailer TEXT,
    category_id TEXT,
    region TEXT,
    is_adult INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER,
    match_key TEXT NOT NULL,
    details_at INTEGER,
    seasons_json TEXT,
    seen_run INTEGER NOT NULL
  );
  CREATE INDEX series_cat ON series(category_id, added_at DESC);
  CREATE INDEX series_added ON series(added_at DESC);
  CREATE INDEX series_match ON series(provider_id, match_key);
  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT NOT NULL,
    plot TEXT,
    thumb TEXT,
    runtime_sec INTEGER,
    container TEXT,
    air_date TEXT,
    reported_height INTEGER,
    url TEXT
  );
  CREATE INDEX episodes_series ON episodes(series_id, season, episode);
  CREATE TABLE programmes (
    provider_id TEXT NOT NULL,
    channel_epg_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    stop INTEGER NOT NULL,
    title TEXT NOT NULL,
    descr TEXT,
    category TEXT
  );
  CREATE INDEX programmes_chan ON programmes(channel_epg_id, start);
  CREATE INDEX programmes_stop ON programmes(stop);
  CREATE TABLE favorites (
    profile_id TEXT NOT NULL,
    content_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    match_key TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, content_id)
  );
  CREATE TABLE progress (
    profile_id TEXT NOT NULL,
    content_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    series_id TEXT,
    match_key TEXT,
    position_sec REAL NOT NULL,
    duration_sec REAL NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, content_id)
  );
  CREATE INDEX progress_recent ON progress(profile_id, updated_at DESC);
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    content_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    category_id TEXT,
    genres TEXT,
    completion REAL NOT NULL DEFAULT 0,
    watched_at INTEGER NOT NULL
  );
  CREATE INDEX history_profile ON history(profile_id, watched_at DESC);
  CREATE TABLE search_history (
    profile_id TEXT NOT NULL,
    query TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, query)
  );
  CREATE TABLE verified_quality (
    content_id TEXT PRIMARY KEY,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    measured_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2: accounts — every person gets their own profiles, history and content sources */ `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE invites (
    code_hash TEXT PRIMARY KEY,
    label TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by TEXT,
    used_at INTEGER
  );
  -- The single owner of version 1 becomes the owner account (signs in as "owner").
  INSERT INTO accounts (id, email, password_hash, role, created_at)
    SELECT 'owner', 'owner', password_hash, 'owner', created_at FROM owner;
  DROP TABLE owner;
  ALTER TABLE sessions ADD COLUMN account_id TEXT;
  ALTER TABLE profiles ADD COLUMN account_id TEXT;
  ALTER TABLE providers ADD COLUMN account_id TEXT;
  UPDATE sessions SET account_id = 'owner' WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'owner');
  UPDATE profiles SET account_id = 'owner' WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'owner');
  UPDATE providers SET account_id = 'owner' WHERE EXISTS (SELECT 1 FROM accounts WHERE id = 'owner');
  DELETE FROM sessions WHERE account_id IS NULL;
  CREATE INDEX profiles_account ON profiles(account_id, sort);
  CREATE INDEX providers_account ON providers(account_id);
  CREATE INDEX sessions_account ON sessions(account_id);
  `,
];

// Loaded via require: some bundlers/test runners don't yet know the prefix-only `node:sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type DB = DatabaseSyncT;

export function openDb(path = join(config.dataDir, 'atlas.sqlite')): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 8000;');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  for (let v = current + 1; v <= MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Run `fn` inside a transaction. node:sqlite is synchronous, so this is atomic for readers. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
