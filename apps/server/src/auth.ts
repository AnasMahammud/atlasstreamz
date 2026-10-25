import { isValidPin, pinLockoutMs } from '@atlas/core';
import type { DB } from './db.ts';
import { getSetting } from './db.ts';
import { config } from './config.ts';
import { hashSecret, randomToken, sha256, verifySecret } from './security.ts';

export const SESSION_COOKIE = 'atlas_session';

/* ---------- Accounts ---------- */

export type Role = 'owner' | 'member';

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export interface Session {
  tokenHash: string;
  accountId: string;
  role: Role;
  email: string;
  profileId: string | null;
  expiresAt: number;
}

export function hasOwner(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM accounts WHERE role = 'owner'`).get();
}

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Enter a password.';
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string' || !email.trim()) return 'Enter your email address.';
  const e = email.trim();
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter a valid email address.';
  return null;
}

export function getAccount(db: DB, id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function findAccount(db: DB, email: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').get(email.trim()) as AccountRow | undefined;
}

export async function createAccount(db: DB, email: string, password: string, role: Role): Promise<string> {
  const id = `a${randomToken(9).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase()}`;
  db.prepare('INSERT INTO accounts (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email.trim(), await hashSecret(password), role, Date.now());
  if (role === 'owner') {
    // Sources imported from the server environment before setup belong to the owner.
    db.prepare('UPDATE providers SET account_id = ? WHERE account_id IS NULL').run(id);
    db.prepare('UPDATE profiles SET account_id = ? WHERE account_id IS NULL').run(id);
  }
  return id;
}

export async function verifyAccountPassword(db: DB, accountId: string, password: string): Promise<boolean> {
  const row = getAccount(db, accountId);
  return !!row && verifySecret(password, row.password_hash);
}

export async function setAccountPassword(db: DB, accountId: string, password: string): Promise<void> {
  db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(await hashSecret(password), accountId);
}

/** Everything that belongs to an account goes with it: profiles, their data, sources and catalogues. */
export function deleteAccount(db: DB, accountId: string): string[] {
  const providerIds = (db.prepare('SELECT id FROM providers WHERE account_id = ?').all(accountId) as Array<{ id: string }>).map((r) => r.id);
  for (const p of db.prepare('SELECT id FROM profiles WHERE account_id = ?').all(accountId) as Array<{ id: string }>) {
    for (const t of ['favorites', 'progress', 'history', 'search_history']) db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(p.id);
  }
  db.prepare('DELETE FROM profiles WHERE account_id = ?').run(accountId);
  for (const pid of providerIds) {
    for (const t of ['programmes', 'episodes', 'channels', 'movies', 'series', 'categories']) db.prepare(`DELETE FROM ${t} WHERE provider_id = ?`).run(pid);
    db.prepare('DELETE FROM providers WHERE id = ?').run(pid);
  }
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  return providerIds;
}

export interface PublicAccount {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  lastLoginAt?: number;
  profiles: number;
  sources: number;
}

export function listAccounts(db: DB): PublicAccount[] {
  return (
    db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS profiles, (SELECT COUNT(*) FROM providers v WHERE v.account_id = a.id) AS sources
         FROM accounts a ORDER BY a.role = 'owner' DESC, a.created_at`,
      )
      .all() as any[]
  ).map((a) => ({
    id: a.id,
    email: a.email,
    role: a.role,
    disabled: a.disabled === 1,
    createdAt: a.created_at,
    lastLoginAt: a.last_login_at ?? undefined,
    profiles: a.profiles,
    sources: a.sources,
  }));
}

/* ---------- Registration & invites ---------- */

export type RegistrationMode = 'closed' | 'invite' | 'open';

export function registrationMode(db: DB): RegistrationMode {
  const m = getSetting<RegistrationMode>(db, 'registration', 'invite');
  return m === 'closed' || m === 'open' ? m : 'invite';
}

/** Invite codes are random, single-use, expire after 7 days and are stored hashed. */
export function createInvite(db: DB, createdBy: string, label?: string): { code: string; expiresAt: number } {
  const code = randomToken(9).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  const expiresAt = Date.now() + 7 * 86_400_000;
  db.prepare('INSERT INTO invites (code_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(code), label?.trim().slice(0, 60) || null, createdBy, Date.now(), expiresAt);
  return { code, expiresAt };
}

export function findUsableInvite(db: DB, code: string): { code_hash: string } | undefined {
  return db.prepare('SELECT code_hash FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?').get(sha256(code.trim().toUpperCase()), Date.now()) as
    | { code_hash: string }
    | undefined;
}

export function useInvite(db: DB, codeHash: string, accountId: string): void {
  db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ?').run(accountId, Date.now(), codeHash);
}

export function listInvites(db: DB) {
  return (
    db
      .prepare(`SELECT i.code_hash, i.label, i.created_at, i.expires_at, i.used_at, a.email AS used_email FROM invites i LEFT JOIN accounts a ON a.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`)
      .all() as any[]
  ).map((i) => ({
    id: i.code_hash.slice(0, 16),
    label: i.label ?? undefined,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    usedAt: i.used_at ?? undefined,
    usedBy: i.used_email ?? undefined,
    status: i.used_at ? 'used' : i.expires_at < Date.now() ? 'expired' : 'active',
  }));
}

/* ---------- Sessions ---------- */

export function createSession(db: DB, accountId: string, userAgent?: string): { token: string; maxAgeSec: number } {
  const token = randomToken();
  const now = Date.now();
  const maxAgeSec = config.sessionDays * 86_400;
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(
    sha256(token),
    accountId,
    now,
    now + maxAgeSec * 1000,
    now,
    (userAgent ?? '').slice(0, 200),
  );
  db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(now, accountId);
  return { token, maxAgeSec };
}

export function getSession(db: DB, token: string | undefined): Session | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT s.token_hash, s.profile_id, s.expires_at, s.last_seen_at, s.account_id, a.role, a.email, a.disabled
       FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`,
    )
    .get(hash) as
    | { token_hash: string; profile_id: string | null; expires_at: number; last_seen_at: number; account_id: string; role: Role; email: string; disabled: number }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - row.last_seen_at > 3_600_000) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash);
  return { tokenHash: row.token_hash, accountId: row.account_id, role: row.role, email: row.email, profileId: row.profile_id, expiresAt: row.expires_at };
}

export function setSessionProfile(db: DB, tokenHash: string, profileId: string | null): void {
  db.prepare('UPDATE sessions SET profile_id = ? WHERE token_hash = ?').run(profileId, tokenHash);
}

export function deleteSession(db: DB, tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

export function listSessions(db: DB, accountId: string) {
  return db.prepare('SELECT token_hash, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC').all(accountId) as Array<{
    token_hash: string;
    created_at: number;
    last_seen_at: number;
    expires_at: number;
    user_agent: string;
  }>;
}

/* ---------- Brute-force protection (passwords, PINs, setup and invite codes) ---------- */

export function lockState(db: DB, key: string): { lockedForMs: number; failures: number } {
  const row = db.prepare('SELECT failures, locked_until FROM auth_attempts WHERE key = ?').get(key) as { failures: number; locked_until: number } | undefined;
  if (!row) return { lockedForMs: 0, failures: 0 };
  return { lockedForMs: Math.max(0, row.locked_until - Date.now()), failures: row.failures };
}

/**
 * Record a failed attempt. `freeAttempts` is how many failures are allowed before waits start.
 * Per-account keys get a higher allowance so a stranger can't easily lock someone out.
 */
export function recordFailure(db: DB, key: string, freeAttempts = 5): { lockedForMs: number; remaining: number } {
  const { failures } = lockState(db, key);
  const next = failures + 1;
  const wait = pinLockoutMs(next - (freeAttempts - 5));
  db.prepare(
    `INSERT INTO auth_attempts (key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).run(key, next, Date.now() + wait, Date.now());
  return { lockedForMs: wait, remaining: Math.max(0, freeAttempts - next) };
}

export function clearFailures(db: DB, key: string): void {
  db.prepare('DELETE FROM auth_attempts WHERE key = ?').run(key);
}

/* ---------- Profiles ---------- */

export interface ProfilePrefs {
  subtitleLang?: string;
  audioLang?: string;
  autoplayNext?: boolean;
  /** Region prefixes (e.g. "DE", "UK") whose catalogue rows appear on Home. */
  regions?: string[];
  maturity?: 'kids' | 'teen' | 'all';
  reducedMotion?: boolean;
  subtitleStyle?: { size: number; background: number };
  dataSaver?: boolean;
  /** Ask for this profile's PIN before opening Settings. */
  lockSettings?: boolean;
}

export interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  avatar: string;
  pin_hash: string | null;
  is_kids: number;
  prefs_json: string;
  sort: number;
  created_at: number;
}

export interface PublicProfile {
  id: string;
  name: string;
  avatar: string;
  hasPin: boolean;
  isKids: boolean;
  prefs: ProfilePrefs;
}

export function toPublicProfile(row: ProfileRow): PublicProfile {
  let prefs: ProfilePrefs = {};
  try {
    prefs = JSON.parse(row.prefs_json) as ProfilePrefs;
  } catch {
    /* default */
  }
  return { id: row.id, name: row.name, avatar: row.avatar, hasPin: !!row.pin_hash, isKids: row.is_kids === 1, prefs };
}

export function listProfiles(db: DB, accountId: string): ProfileRow[] {
  return db.prepare('SELECT * FROM profiles WHERE account_id = ? ORDER BY sort, created_at').all(accountId) as unknown as ProfileRow[];
}

/** A profile, only if it belongs to the given account. */
export function getProfile(db: DB, id: string, accountId: string): ProfileRow | undefined {
  return db.prepare('SELECT * FROM profiles WHERE id = ? AND account_id = ?').get(id, accountId) as ProfileRow | undefined;
}

export const AVATARS = ['aurora', 'nebula', 'tide', 'ember', 'meadow', 'dusk', 'glacier', 'orbit'] as const;

export function validateProfileInput(input: { name?: unknown; avatar?: unknown }): string | null {
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) return 'Enter a profile name.';
    if (input.name.trim().length > 24) return 'Use 24 characters or fewer.';
  }
  if (input.avatar !== undefined && !AVATARS.includes(input.avatar as (typeof AVATARS)[number])) return 'Choose one of the avatars.';
  return null;
}

export async function createProfile(db: DB, accountId: string, input: { name: string; avatar: string; isKids?: boolean; pin?: string }): Promise<string> {
  if (input.pin !== undefined && !isValidPin(input.pin)) throw new Error('PINs are 4 to 6 digits.');
  const id = `u${randomToken(6).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}`;
  const sort = (db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?').get(accountId) as { n: number }).n;
  const prefs: ProfilePrefs = { autoplayNext: true, maturity: input.isKids ? 'kids' : 'all' };
  db.prepare('INSERT INTO profiles (id, account_id, name, avatar, pin_hash, is_kids, prefs_json, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    accountId,
    input.name.trim(),
    input.avatar,
    input.pin ? await hashSecret(input.pin) : null,
    input.isKids ? 1 : 0,
    JSON.stringify(prefs),
    sort,
    Date.now(),
  );
  return id;
}

export type PinCheck = { ok: true } | { ok: false; reason: 'wrong' | 'locked' | 'invalid'; lockedForMs?: number; remaining?: number };

/** Verify a profile PIN with lockout. Profiles without a PIN always pass. */
export async function checkProfilePin(db: DB, profile: ProfileRow, pin: unknown): Promise<PinCheck> {
  if (!profile.pin_hash) return { ok: true };
  const key = `pin:${profile.id}`;
  const lock = lockState(db, key);
  if (lock.lockedForMs > 0) return { ok: false, reason: 'locked', lockedForMs: lock.lockedForMs };
  if (typeof pin !== 'string' || !isValidPin(pin)) return { ok: false, reason: 'invalid' };
  if (await verifySecret(pin, profile.pin_hash)) {
    clearFailures(db, key);
    return { ok: true };
  }
  const f = recordFailure(db, key);
  return { ok: false, reason: f.lockedForMs > 0 ? 'locked' : 'wrong', lockedForMs: f.lockedForMs || undefined, remaining: f.remaining };
}

export async function setProfilePin(db: DB, profileId: string, pin: string | null): Promise<void> {
  if (pin !== null && !isValidPin(pin)) throw new Error('PINs are 4 to 6 digits.');
  db.prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(pin ? await hashSecret(pin) : null, profileId);
  clearFailures(db, `pin:${profileId}`);
}
