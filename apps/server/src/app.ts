import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { parseContentId, isValidPin } from '@atlas/core';
import type { DB } from './db.ts';
import { getSetting, setSetting } from './db.ts';
import { config } from './config.ts';
import { log } from './log.ts';
import { createSubtitleService, SubtitleError, type SearchTarget, type SubtitleService } from './subtitles.ts';
import {
  AVATARS,
  SESSION_COOKIE,
  checkProfilePin,
  clearFailures,
  createAccount,
  createInvite,
  createProfile,
  createSession,
  deleteAccount,
  deleteSession,
  findAccount,
  findUsableInvite,
  getAccount,
  getProfile,
  getSession,
  hasOwner,
  listAccounts,
  listInvites,
  listProfiles,
  listSessions,
  lockState,
  recordFailure,
  registrationMode,
  setAccountPassword,
  setProfilePin,
  setSessionProfile,
  toPublicProfile,
  useInvite,
  validateEmail,
  validatePassword,
  validateProfileInput,
  verifyAccountPassword,
  type ProfilePrefs,
  type ProfileRow,
  type RegistrationMode,
  type Session,
} from './auth.ts';
import { accountProviderIds, getProvider, insertProvider, listProviders, providerOwnedBy, secretFromInput, testConnection, toPublic, getSecret, type ProviderRow } from './providers.ts';
import { sha256, verifySecret } from './security.ts';
import {
  CatalogSearch,
  attachNowNext,
  audienceFor,
  browse,
  browseChannels,
  channelDetails,
  continueWatching,
  heroItems,
  homeRows,
  listCategories,
  lookupCards,
  movieDetails,
  myList,
  neighbourChannels,
  programmesFor,
  providerSql,
  recentChannels,
  recommendationPool,
  seriesDetails,
  type Audience,
  type Card,
} from './catalog.ts';
import { SyncManager } from './sync/manager.ts';
import { handleHlsToken, handleLive, handleVod, playbackSources, PlaybackError, providerAuthStatus } from './stream.ts';
import { clearImageCache, imageCacheStats, serveImage } from './images.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    profile: ProfileRow | null;
  }
}

interface Ctx {
  db: DB;
  sync: SyncManager;
  search: CatalogSearch;
  /** Online subtitles; tests pass one with a stand-in for the OpenSubtitles API. */
  subtitles?: SubtitleService;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const bad = (msg: string, extra?: Record<string, unknown>) => new HttpError(400, msg, extra);

/** Settings-level actions require a recent PIN/password confirmation when the profile locks settings. */
const elevated = new Map<string, number>();

const MAX_PROFILES = 8;
const MAX_SOURCES = 5;

export async function buildApp(ctx: Ctx) {
  const { db, sync, search } = ctx;
  const subtitles = ctx.subtitles ?? createSubtitleService(db, config.dataDir);
  // A hop count trusts only the nearest N proxies, so a client can't spoof X-Forwarded-For.
  const hops = config.trustProxy;
  const trustProxy = typeof hops === 'number' ? (_address: string, hop: number) => hop < hops : hops;
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024, trustProxy, routerOptions: { maxParamLength: 4096 } });
  await app.register(cookie);

  app.decorateRequest('session', null);
  app.decorateRequest('profile', null);

  // Basic security headers for every response.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.addHook('onRequest', async (req) => {
    req.session = getSession(db, req.cookies[SESSION_COOKIE]);
    if (req.session?.profileId) req.profile = getProfile(db, req.session.profileId, req.session.accountId) ?? null;
    // CSRF: state-changing requests must come from our own origin.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof SubtitleError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if ((err as any).validation || (err as any).statusCode === 400) return reply.code(400).send({ error: 'Invalid request.' });
    log.error(`${req.method} ${req.url}`, err);
    return reply.code(500).send({ error: 'Something went wrong on the ATLAS server.' });
  });

  /* ---------------- guards ---------------- */

  const needSession = (req: FastifyRequest): Session => {
    if (!req.session) throw new HttpError(401, 'Sign in to continue.');
    return req.session;
  };
  const needOwner = (req: FastifyRequest): Session => {
    const s = needSession(req);
    if (s.role !== 'owner') throw new HttpError(403, 'Only the server owner can do that.');
    return s;
  };
  const needProfile = (req: FastifyRequest): ProfileRow => {
    needSession(req);
    if (!req.profile) throw new HttpError(409, 'Choose a profile first.', { code: 'profile_required' });
    return req.profile;
  };
  const prefsOf = (p: ProfileRow): ProfilePrefs => toPublicProfile(p).prefs;
  const myProviderIds = (req: FastifyRequest) => accountProviderIds(db, needSession(req).accountId);
  const audience = (req: FastifyRequest): Audience => {
    const p = needProfile(req);
    return audienceFor(prefsOf(p), p.is_kids === 1, myProviderIds(req));
  };
  /** Content, streams and sources are only reachable by the account that owns the provider. */
  const assertOwnsContent = (req: FastifyRequest, contentId: string) => {
    const s = needSession(req);
    const parsed = parseContentId(contentId);
    if (!parsed || !providerOwnedBy(db, parsed.providerId, s.accountId)) throw new HttpError(404, 'Not found.');
    return parsed;
  };
  const ownedProvider = (req: FastifyRequest, id: string): ProviderRow => {
    const s = needSession(req);
    const row = getProvider(db, id);
    if (!row || row.account_id !== s.accountId) throw new HttpError(404, 'Source not found.');
    return row;
  };
  const needElevation = (req: FastifyRequest) => {
    const s = needSession(req);
    const p = req.profile;
    const locked = p && p.pin_hash && prefsOf(p).lockSettings;
    const kids = p && p.is_kids === 1;
    if ((locked || kids) && (elevated.get(s.tokenHash) ?? 0) < Date.now()) {
      throw new HttpError(403, kids ? 'Ask the account holder to unlock settings.' : 'Enter your PIN to change settings.', { code: 'elevation_required' });
    }
  };
  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as T;
  const q = <T>(req: FastifyRequest) => (req.query ?? {}) as T;

  const setSessionCookie = (reply: FastifyReply, token: string, maxAge: number) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge, secure: config.secureCookies });

  const checkCode = (given: unknown, expected: string) => {
    const a = Buffer.from(sha256(String(given ?? '').trim()));
    const b = Buffer.from(sha256(expected));
    return timingSafeEqual(a, b);
  };

  /* ---------------- status, setup, sign-in, sign-up ---------------- */

  app.get('/api/status', async (req) => {
    const s = req.session;
    const providerIds = s ? accountProviderIds(db, s.accountId) : [];
    return {
      setupRequired: !hasOwner(db),
      setupCodeRequired: !hasOwner(db) && !!config.setupToken,
      registration: registrationMode(db),
      signedIn: !!s,
      account: s ? { email: s.email, role: s.role } : null,
      profile: req.profile ? toPublicProfile(req.profile) : null,
      providers: s ? listProviders(db, s.accountId).map(toPublic) : undefined,
      sync: s ? syncPublic(s.accountId) : undefined,
      catalog: s ? catalogCounts(providerIds) : undefined,
      server: { version: '0.2.0', time: Date.now() },
    };
  });

  app.post('/api/setup', async (req, reply) => {
    if (hasOwner(db)) throw new HttpError(409, 'ATLAS is already set up.');
    const { email, password, setupCode } = body<{ email: string; password: string; setupCode?: string }>(req);
    if (config.setupToken) {
      const key = `setup:${req.ip}`;
      if (lockState(db, key).lockedForMs > 0) throw new HttpError(429, 'Too many attempts. Try again shortly.');
      if (!checkCode(setupCode, config.setupToken)) {
        recordFailure(db, key);
        throw new HttpError(401, 'That setup code is not right. Find ATLAS_SETUP_TOKEN in your hosting dashboard.', { code: 'setup_code' });
      }
      clearFailures(db, key);
    }
    const err = validateEmail(email) ?? validatePassword(password);
    if (err) throw bad(err);
    const id = await createAccount(db, email, password, 'owner');
    const s = createSession(db, id, req.headers['user-agent']);
    setSessionCookie(reply, s.token, s.maxAgeSec);
    log.info('Owner account created');
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ipKey = `login:${req.ip}`;
    const ipLock = lockState(db, ipKey);
    if (ipLock.lockedForMs > 0) throw new HttpError(429, 'Too many attempts. Try again shortly.', { retryInMs: ipLock.lockedForMs });
    const { email, password } = body<{ email: string; password: string }>(req);
    const account = typeof email === 'string' && email.trim() ? findAccount(db, email) : undefined;
    const acctKey = account ? `login-acct:${account.id}` : null;
    if (acctKey && lockState(db, acctKey).lockedForMs > 0) throw new HttpError(429, 'This account is temporarily locked after many failed sign-ins. Try again later.');
    // Verify even when the account doesn't exist, so timing doesn't reveal which emails are registered.
    const ok = typeof password === 'string' && (await verifySecret(password, account?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='));
    if (!account || !ok) {
      const f = recordFailure(db, ipKey);
      if (acctKey) recordFailure(db, acctKey, 20);
      throw new HttpError(401, 'That email or password is not right.', { retryInMs: f.lockedForMs || undefined });
    }
    if (account.disabled) throw new HttpError(403, 'This account has been disabled by the server owner.');
    clearFailures(db, ipKey);
    if (acctKey) clearFailures(db, acctKey);
    const s = createSession(db, account.id, req.headers['user-agent']);
    setSessionCookie(reply, s.token, s.maxAgeSec);
    return { ok: true };
  });

  /** Self-service sign-up, controlled by the owner: closed, invite-only (default) or open. */
  app.post('/api/auth/register', async (req, reply) => {
    if (!hasOwner(db)) throw new HttpError(409, 'This server hasn’t been set up yet.');
    const mode = registrationMode(db);
    if (mode === 'closed') throw new HttpError(403, 'New sign-ups are closed on this server.');
    const { email, password, inviteCode } = body<{ email: string; password: string; inviteCode?: string }>(req);
    let invite: { code_hash: string } | undefined;
    if (mode === 'invite') {
      const key = `invite:${req.ip}`;
      if (lockState(db, key).lockedForMs > 0) throw new HttpError(429, 'Too many attempts. Try again shortly.');
      invite = typeof inviteCode === 'string' ? findUsableInvite(db, inviteCode) : undefined;
      if (!invite) {
        recordFailure(db, key);
        throw new HttpError(401, 'That invite code isn’t valid or has already been used.', { code: 'invite' });
      }
      clearFailures(db, key);
    }
    const err = validateEmail(email) ?? validatePassword(password);
    if (err) throw bad(err);
    if (findAccount(db, email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    const id = await createAccount(db, email, password, 'member');
    if (invite) useInvite(db, invite.code_hash, id);
    const s = createSession(db, id, req.headers['user-agent']);
    setSessionCookie(reply, s.token, s.maxAgeSec);
    log.info(`Account created (${mode})`);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) deleteSession(db, req.session.tokenHash);
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies });
    return { ok: true };
  });

  /** Confirm identity for settings changes: the current profile's PIN or the account password. */
  app.post('/api/auth/elevate', async (req) => {
    const s = needSession(req);
    const { pin, password } = body<{ pin?: string; password?: string }>(req);
    if (password) {
      const key = `elevate:${s.accountId}`;
      if (lockState(db, key).lockedForMs > 0) throw new HttpError(429, 'Too many attempts. Try again shortly.');
      if (!(await verifyAccountPassword(db, s.accountId, password))) {
        recordFailure(db, key);
        throw new HttpError(401, 'That password is not right.');
      }
      clearFailures(db, key);
    } else {
      const p = needProfile(req);
      const r = await checkProfilePin(db, p, pin);
      if (!r.ok) throw new HttpError(r.reason === 'locked' ? 429 : 401, r.reason === 'locked' ? 'Too many wrong PINs. Try again later.' : 'Wrong PIN.', r);
    }
    elevated.set(s.tokenHash, Date.now() + 10 * 60_000);
    return { ok: true, until: elevated.get(s.tokenHash) };
  });

  /* ---------------- your account ---------------- */

  app.get('/api/account', async (req) => {
    const s = needSession(req);
    const a = getAccount(db, s.accountId)!;
    return { email: a.email, role: a.role, createdAt: a.created_at };
  });

  app.post('/api/account/password', async (req) => {
    const s = needSession(req);
    const { currentPassword, newPassword } = body<{ currentPassword: string; newPassword: string }>(req);
    const key = `elevate:${s.accountId}`;
    if (lockState(db, key).lockedForMs > 0) throw new HttpError(429, 'Too many attempts. Try again shortly.');
    if (typeof currentPassword !== 'string' || !(await verifyAccountPassword(db, s.accountId, currentPassword))) {
      recordFailure(db, key);
      throw new HttpError(401, 'Your current password is not right.');
    }
    const err = validatePassword(newPassword);
    if (err) throw bad(err);
    await setAccountPassword(db, s.accountId, newPassword);
    // Sign out every other device.
    db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?').run(s.accountId, s.tokenHash);
    return { ok: true };
  });

  app.delete('/api/account', async (req, reply) => {
    const s = needSession(req);
    if (s.role === 'owner') throw new HttpError(409, 'The server owner’s account can’t be deleted.');
    const { password } = body<{ password: string }>(req);
    if (typeof password !== 'string' || !(await verifyAccountPassword(db, s.accountId, password))) throw new HttpError(401, 'That password is not right.');
    deleteAccount(db, s.accountId);
    search.rebuild(db);
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies });
    return { ok: true };
  });

  app.get('/api/sessions', async (req) => {
    const s = needSession(req);
    return listSessions(db, s.accountId).map((x) => ({
      id: x.token_hash.slice(0, 12),
      current: x.token_hash === s.tokenHash,
      createdAt: x.created_at,
      lastSeenAt: x.last_seen_at,
      device: x.user_agent,
    }));
  });

  app.delete('/api/sessions/:id', async (req) => {
    const s = needSession(req);
    needElevation(req);
    const { id } = req.params as { id: string };
    const row = listSessions(db, s.accountId).find((x) => x.token_hash.startsWith(id) && id.length >= 12);
    if (!row) throw new HttpError(404, 'Session not found.');
    deleteSession(db, row.token_hash);
    return { ok: true };
  });

  /* ---------------- members (server owner only) ---------------- */

  app.get('/api/admin/accounts', async (req) => {
    needOwner(req);
    return { accounts: listAccounts(db), registration: registrationMode(db), invites: listInvites(db) };
  });

  app.put('/api/admin/registration', async (req) => {
    needOwner(req);
    needElevation(req);
    const { mode } = body<{ mode: RegistrationMode }>(req);
    if (!['closed', 'invite', 'open'].includes(mode)) throw bad('Choose closed, invite or open.');
    setSetting(db, 'registration', mode);
    return { registration: mode };
  });

  app.post('/api/admin/invites', async (req) => {
    const s = needOwner(req);
    needElevation(req);
    return createInvite(db, s.accountId, body<{ label?: string }>(req).label);
  });

  app.delete('/api/admin/invites/:id', async (req) => {
    needOwner(req);
    needElevation(req);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{16}$/.test(id)) throw bad('Invalid invite.');
    db.prepare(`DELETE FROM invites WHERE substr(code_hash, 1, 16) = ? AND used_by IS NULL`).run(id);
    return { ok: true };
  });

  app.patch('/api/admin/accounts/:id', async (req) => {
    const s = needOwner(req);
    needElevation(req);
    const { id } = req.params as { id: string };
    if (id === s.accountId) throw bad('You can’t disable your own account.');
    const target = getAccount(db, id);
    if (!target) throw new HttpError(404, 'Account not found.');
    const { disabled } = body<{ disabled: boolean }>(req);
    db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
    return { ok: true };
  });

  app.delete('/api/admin/accounts/:id', async (req) => {
    const s = needOwner(req);
    needElevation(req);
    const { id } = req.params as { id: string };
    const target = getAccount(db, id);
    if (!target) throw new HttpError(404, 'Account not found.');
    if (id === s.accountId || target.role === 'owner') throw bad('The owner account can’t be deleted.');
    const removed = deleteAccount(db, id);
    if (removed.length) search.rebuild(db);
    return { ok: true };
  });

  /* ---------------- profiles ---------------- */

  app.get('/api/profiles', async (req) => {
    const s = needSession(req);
    return { profiles: listProfiles(db, s.accountId).map(toPublicProfile), avatars: AVATARS };
  });

  app.post('/api/profiles', async (req) => {
    const s = needSession(req);
    if (req.profile) needElevation(req);
    const input = body<{ name: string; avatar: string; isKids?: boolean; pin?: string }>(req);
    const err = validateProfileInput(input);
    if (err || !input.name) throw bad(err ?? 'Enter a profile name.');
    if (input.pin && !isValidPin(input.pin)) throw bad('PINs are 4 to 6 digits.');
    if (listProfiles(db, s.accountId).length >= MAX_PROFILES) throw bad(`An account can have up to ${MAX_PROFILES} profiles.`);
    const id = await createProfile(db, s.accountId, { name: input.name, avatar: input.avatar, isKids: !!input.isKids, pin: input.pin || undefined });
    return toPublicProfile(getProfile(db, id, s.accountId)!);
  });

  const profileOr404 = (req: FastifyRequest): ProfileRow => {
    const s = needSession(req);
    const { id } = req.params as { id: string };
    const p = getProfile(db, id, s.accountId);
    if (!p) throw new HttpError(404, 'Profile not found.');
    return p;
  };

  app.post('/api/profiles/:id/select', async (req) => {
    const s = needSession(req);
    const p = profileOr404(req);
    const r = await checkProfilePin(db, p, body<{ pin?: string }>(req).pin);
    if (!r.ok) {
      const msg = r.reason === 'locked' ? 'Too many wrong PINs. This profile is locked for a while.' : r.reason === 'invalid' ? 'Enter this profile’s PIN.' : 'Wrong PIN.';
      throw new HttpError(r.reason === 'locked' ? 429 : 401, msg, { reason: r.reason, lockedForMs: r.lockedForMs, remaining: r.remaining });
    }
    setSessionProfile(db, s.tokenHash, p.id);
    elevated.delete(s.tokenHash);
    return toPublicProfile(p);
  });

  app.post('/api/profiles/deselect', async (req) => {
    const s = needSession(req);
    setSessionProfile(db, s.tokenHash, null);
    elevated.delete(s.tokenHash);
    return { ok: true };
  });

  /** Editing a profile: its own PIN, an elevated session, or the account password. */
  const authorizeProfileEdit = async (req: FastifyRequest, target: ProfileRow, creds: { pin?: string; password?: string }) => {
    const s = needSession(req);
    if (creds.password) {
      if (!(await verifyAccountPassword(db, s.accountId, creds.password))) throw new HttpError(401, 'That password is not right.');
      return;
    }
    if (!target.pin_hash) return;
    if (req.profile?.id === target.id && (elevated.get(s.tokenHash) ?? 0) > Date.now()) return;
    // Editing your own protected profile: ask the client to confirm the PIN once (elevation).
    if (req.profile?.id === target.id && !creds.pin) throw new HttpError(403, 'Enter your PIN to change this.', { code: 'elevation_required' });
    const r = await checkProfilePin(db, target, creds.pin);
    if (!r.ok) throw new HttpError(r.reason === 'locked' ? 429 : 401, r.reason === 'locked' ? 'Too many wrong PINs.' : 'Enter this profile’s PIN to edit it.', { code: 'pin_required' });
  };

  app.patch('/api/profiles/:id', async (req) => {
    const s = needSession(req);
    const p = profileOr404(req);
    const input = body<{ name?: string; avatar?: string; isKids?: boolean; prefs?: Partial<ProfilePrefs>; pin?: string; password?: string }>(req);
    // Everyday preferences on your own profile need no PIN; identity and safety settings do.
    const sensitive =
      input.name !== undefined || input.avatar !== undefined || input.isKids !== undefined || input.prefs?.maturity !== undefined || input.prefs?.lockSettings !== undefined;
    if (sensitive || req.profile?.id !== p.id) await authorizeProfileEdit(req, p, input);
    const err = validateProfileInput(input);
    if (err) throw bad(err);
    // Leaving kids mode needs the account password, not just the kid's own PIN.
    if (p.is_kids === 1 && input.isKids === false && !(input.password && (await verifyAccountPassword(db, s.accountId, input.password)))) {
      throw new HttpError(403, 'The account password is needed to turn off Kids mode.', { code: 'owner_required' });
    }
    const prefs = { ...prefsOf(p), ...(input.prefs ?? {}) };
    if (input.prefs?.maturity && input.prefs.maturity !== 'kids' && p.is_kids === 1) prefs.maturity = 'kids';
    db.prepare('UPDATE profiles SET name = ?, avatar = ?, is_kids = ?, prefs_json = ? WHERE id = ?').run(
      input.name?.trim() ?? p.name,
      input.avatar ?? p.avatar,
      input.isKids === undefined ? p.is_kids : input.isKids ? 1 : 0,
      JSON.stringify(prefs),
      p.id,
    );
    return toPublicProfile(getProfile(db, p.id, s.accountId)!);
  });

  app.post('/api/profiles/:id/pin', async (req) => {
    const s = needSession(req);
    const p = profileOr404(req);
    const input = body<{ currentPin?: string; newPin?: string | null; password?: string }>(req);
    await authorizeProfileEdit(req, p, { pin: input.currentPin, password: input.password });
    if (input.newPin && !isValidPin(input.newPin)) throw bad('PINs are 4 to 6 digits.');
    await setProfilePin(db, p.id, input.newPin || null);
    return toPublicProfile(getProfile(db, p.id, s.accountId)!);
  });

  app.delete('/api/profiles/:id', async (req) => {
    const p = profileOr404(req);
    await authorizeProfileEdit(req, p, body<{ pin?: string; password?: string }>(req));
    for (const t of ['favorites', 'progress', 'history', 'search_history']) db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(p.id);
    db.prepare('UPDATE sessions SET profile_id = NULL WHERE profile_id = ?').run(p.id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(p.id);
    return { ok: true };
  });

  /* ---------------- content sources & sync (per account) ---------------- */

  const syncPublic = (accountId: string) => {
    const mine = new Set(listProviders(db, accountId).map((p) => p.id));
    const running = sync.state.running && mine.has(sync.state.running.providerId) ? sync.state.running : null;
    return {
      running: running && { providerId: running.providerId, stage: running.stage, detail: running.detail, startedAt: running.startedAt },
      queue: sync.state.queue.filter((id) => mine.has(id)),
      last: Object.fromEntries(Object.entries(sync.state.last).filter(([id]) => mine.has(id))),
      next: Object.fromEntries(listProviders(db, accountId).map((p) => [p.id, sync.nextRunAt(p)])),
    };
  };

  const catalogCounts = (providers: string[]) => {
    const own = providerSql({ providers }, 't');
    const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} t WHERE ${own}`).get() as { n: number }).n;
    return { channels: n('channels'), movies: n('movies'), series: n('series'), programmes: n('programmes') };
  };

  app.get('/api/providers', async (req) => {
    const s = needSession(req);
    return { providers: listProviders(db, s.accountId).map(toPublic), sync: syncPublic(s.accountId) };
  });

  const parseSource = (input: unknown) => {
    try {
      return secretFromInput(input as Parameters<typeof secretFromInput>[0]);
    } catch (err) {
      throw bad(err instanceof Error ? err.message : 'Invalid provider.');
    }
  };

  app.post('/api/providers/test', async (req) => {
    needSession(req);
    needElevation(req);
    const secret = parseSource(body(req));
    const insecure = new URL(secret.type === 'xtream' ? secret.baseUrl : secret.url).protocol === 'http:';
    if (insecure && !body<{ allowHttp?: boolean }>(req).allowHttp) {
      return { ok: false, needsHttpConsent: true, message: 'This provider uses unencrypted HTTP. Your credentials and viewing would be visible on the network.' };
    }
    return testConnection(secret);
  });

  app.post('/api/providers', async (req) => {
    const s = needSession(req);
    needElevation(req);
    if (listProviders(db, s.accountId).length >= MAX_SOURCES) throw bad(`An account can have up to ${MAX_SOURCES} sources.`);
    const input = body<{ name?: string; m3uUrl?: string; serverUrl?: string; username?: string; password?: string; epgUrl?: string; allowHttp?: boolean }>(req);
    const secret = parseSource(input);
    const id = insertProvider(db, s.accountId, input.name ?? '', secret);
    if (input.allowHttp) db.prepare('UPDATE providers SET http_consent = 1 WHERE id = ?').run(id);
    const row = getProvider(db, id)!;
    if (!(row.is_https === 0 && row.http_consent === 0)) sync.enqueue(id, 'setup');
    return toPublic(row);
  });

  app.patch('/api/providers/:id', async (req) => {
    needElevation(req);
    const row = ownedProvider(req, (req.params as { id: string }).id);
    const input = body<{ name?: string; enabled?: boolean; autoSync?: boolean; allowHttp?: boolean }>(req);
    db.prepare('UPDATE providers SET name = ?, enabled = ?, auto_sync = ?, http_consent = ? WHERE id = ?').run(
      input.name?.trim() || row.name,
      input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
      input.autoSync === undefined ? row.auto_sync : input.autoSync ? 1 : 0,
      input.allowHttp === undefined ? row.http_consent : input.allowHttp ? 1 : 0,
      row.id,
    );
    const updated = getProvider(db, row.id)!;
    if (input.allowHttp && !updated.last_success_at) sync.enqueue(row.id, 'setup');
    return toPublic(updated);
  });

  app.post('/api/providers/:id/test', async (req) => {
    const row = ownedProvider(req, (req.params as { id: string }).id);
    if (row.is_https === 0 && row.http_consent === 0) return { ok: false, needsHttpConsent: true, message: 'Allow the unencrypted HTTP connection first.' };
    const r = await testConnection(getSecret(row));
    if (r.account) db.prepare('UPDATE providers SET account_json = ? WHERE id = ?').run(JSON.stringify(r.account), row.id);
    return r;
  });

  app.post('/api/providers/:id/sync', async (req) => {
    const s = needSession(req);
    const row = ownedProvider(req, (req.params as { id: string }).id);
    if (row.is_https === 0 && row.http_consent === 0) throw new HttpError(409, 'Allow the unencrypted HTTP connection first.', { code: 'consent' });
    return { queued: sync.enqueue(row.id, 'manual'), sync: syncPublic(s.accountId) };
  });

  app.delete('/api/providers/:id', async (req) => {
    needElevation(req);
    const row = ownedProvider(req, (req.params as { id: string }).id);
    if (sync.state.running?.providerId === row.id) throw new HttpError(409, 'Wait for the current sync to finish.');
    for (const t of ['programmes', 'episodes', 'channels', 'movies', 'series', 'categories']) db.prepare(`DELETE FROM ${t} WHERE provider_id = ?`).run(row.id);
    db.prepare('DELETE FROM providers WHERE id = ?').run(row.id);
    search.rebuild(db);
    return { ok: true };
  });

  app.get('/api/sync/status', async (req) => {
    const s = needSession(req);
    const mine = listProviders(db, s.accountId).map((p) => p.id);
    const runs = mine.length
      ? (db
          .prepare(`SELECT id, provider_id, started_at, finished_at, ok, trigger, summary_json, error FROM sync_runs WHERE provider_id IN (${mine.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 10`)
          .all(...mine) as any[])
      : [];
    return { ...syncPublic(s.accountId), runs: runs.map((r) => ({ ...r, summary: r.summary_json ? JSON.parse(r.summary_json) : undefined, summary_json: undefined })) };
  });

  /* ---------------- catalogue ---------------- */

  const recPools = new Map<string, { at: number; cards: Card[] }>();
  const recCandidates = (providers: string[]) => () => {
    const key = [...providers].sort().join(',');
    let pool = recPools.get(key);
    if (!pool || Date.now() - pool.at > 10 * 60_000) {
      pool = { at: Date.now(), cards: recommendationPool(db, providers) };
      recPools.set(key, pool);
    }
    return pool.cards;
  };
  sync.on('catalogChanged', () => recPools.clear());

  app.get('/api/home', async (req) => {
    const p = needProfile(req);
    const a = audience(req);
    return { hero: heroItems(db, a), rows: homeRows(db, p.id, a, recCandidates(a.providers)) };
  });

  app.get('/api/categories', async (req) => {
    const { kind } = q<{ kind: 'live' | 'movie' | 'series' }>(req);
    if (!['live', 'movie', 'series'].includes(kind)) throw bad('Unknown kind.');
    return listCategories(db, kind, audience(req));
  });

  const browseQuery = (req: FastifyRequest) => {
    const x = q<Record<string, string>>(req);
    return {
      categoryId: x.category || undefined,
      genre: x.genre || undefined,
      sort: (['added', 'title', 'year', 'rating'].includes(x.sort) ? x.sort : 'added') as 'added',
      yearFrom: x.yearFrom ? Number(x.yearFrom) : undefined,
      yearTo: x.yearTo ? Number(x.yearTo) : undefined,
      offset: Math.max(0, Number(x.offset) || 0),
      limit: Math.max(1, Math.min(200, Number(x.limit) || 60)),
    };
  };

  app.get('/api/movies', async (req) => browse(db, 'movie', audience(req), browseQuery(req)));
  app.get('/api/series', async (req) => browse(db, 'series', audience(req), browseQuery(req)));
  app.get('/api/channels', async (req) => {
    const x = browseQuery(req);
    return browseChannels(db, audience(req), { categoryId: x.categoryId, offset: x.offset, limit: x.limit });
  });

  const withUserState = (req: FastifyRequest, id: string) => {
    const p = needProfile(req);
    const fav = !!db.prepare('SELECT 1 FROM favorites WHERE profile_id = ? AND content_id = ?').get(p.id, id);
    const prog = db.prepare('SELECT position_sec, duration_sec, finished FROM progress WHERE profile_id = ? AND content_id = ?').get(p.id, id) as
      | { position_sec: number; duration_sec: number; finished: number }
      | undefined;
    return { inList: fav, progress: prog ? { position: prog.position_sec, duration: prog.duration_sec, finished: !!prog.finished } : undefined };
  };

  const assertAllowed = (req: FastifyRequest, card: { categoryId?: string }) => {
    const a = audience(req);
    if (!card.categoryId) return;
    const c = db.prepare('SELECT is_adult, genre FROM categories WHERE id = ?').get(card.categoryId) as { is_adult: number; genre: string | null } | undefined;
    if (c?.is_adult) throw new HttpError(403, 'This title is restricted.');
    if (a.kids && !['kids', 'animation'].includes(c?.genre ?? '')) throw new HttpError(403, 'This title isn’t available on a Kids profile.');
  };

  app.get('/api/movies/:id', async (req) => {
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const d = await movieDetails(db, id);
    if (!d) throw new HttpError(404, 'This movie is no longer available.');
    assertAllowed(req, d);
    return { ...d, ...withUserState(req, id) };
  });

  app.get('/api/series/:id', async (req) => {
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const d = await seriesDetails(db, id);
    if (!d) throw new HttpError(404, 'This series is no longer available.');
    assertAllowed(req, d);
    const p = needProfile(req);
    const prog = db.prepare('SELECT content_id, position_sec, duration_sec, finished, updated_at FROM progress WHERE profile_id = ? AND series_id = ?').all(p.id, id) as any[];
    const progress = Object.fromEntries(prog.map((r) => [r.content_id, { position: r.position_sec, duration: r.duration_sec, finished: !!r.finished, updatedAt: r.updated_at }]));
    // Next episode: after the most recently watched one (or the first).
    const last = prog.sort((a, b) => b.updated_at - a.updated_at)[0];
    let nextEpisodeId = d.episodes[0]?.id;
    if (last) {
      const idx = d.episodes.findIndex((e) => e.id === last.content_id);
      nextEpisodeId = last.finished ? (d.episodes[idx + 1]?.id ?? d.episodes[idx]?.id) : last.content_id;
    }
    return { ...d, ...withUserState(req, id), episodeProgress: progress, nextEpisodeId };
  });

  app.get('/api/channels/:id', async (req) => {
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const d = channelDetails(db, id);
    if (!d) throw new HttpError(404, 'This channel is no longer available.');
    assertAllowed(req, d);
    const now = Date.now();
    return { ...d, ...withUserState(req, id), schedule: programmesFor(db, [id], now - 3_600_000, now + 24 * 3_600_000)[id] ?? [], ...neighbourChannels(db, id) };
  });

  app.get('/api/guide', async (req) => {
    const a = audience(req);
    const x = q<Record<string, string>>(req);
    const from = Number(x.from) || Date.now() - 30 * 60_000;
    const to = Number(x.to) || from + 4 * 3_600_000;
    const page = browseChannels(db, a, { categoryId: x.category || undefined, offset: Number(x.offset) || 0, limit: Math.min(80, Number(x.limit) || 40) });
    return { ...page, from, to, programmes: programmesFor(db, page.items.map((c) => c.id), from, to) };
  });

  app.get('/api/live/home', async (req) => {
    const p = needProfile(req);
    const a = audience(req);
    return {
      favourites: myList(db, p.id).filter((c) => c.kind === 'live'),
      recent: recentChannels(db, p.id, 16),
      categories: listCategories(db, 'live', a),
    };
  });

  /* ---------------- search ---------------- */

  app.get('/api/search', async (req) => {
    const p = needProfile(req);
    const a = audience(req);
    const { q: query = '', kind } = q<{ q?: string; kind?: string }>(req);
    const text = String(query).slice(0, 80);
    if (!text.trim()) {
      const history = (db.prepare('SELECT query FROM search_history WHERE profile_id = ? ORDER BY at DESC LIMIT 10').all(p.id) as Array<{ query: string }>).map((r) => r.query);
      return { query: '', results: [], history };
    }
    const mine = new Set(a.providers);
    const visible = (doc: { id: string }) => mine.has(doc.id.slice(0, doc.id.indexOf(':')));
    const kinds = kind && ['movie', 'series', 'live'].includes(kind) ? [kind as 'movie'] : (['movie', 'series', 'live', 'category'] as const);
    const hits = search.index.search(text, { limit: 120, kinds: [...kinds], filter: visible });
    const cards = lookupCards(db, hits.filter((h) => h.kind !== 'category').map((h) => h.id));
    const categories = hits.filter((h) => h.kind === 'category').slice(0, 8);
    const catRows = categories.length
      ? (db.prepare(`SELECT id, name, kind, genre, region FROM categories WHERE id IN (${categories.map(() => '?').join(',')})`).all(...categories.map((c) => c.id)) as any[])
      : [];
    // Hide what this profile may not see; group same-title duplicates (other languages/categories).
    const seen = new Set<string>();
    const results: Card[] = [];
    for (const h of hits) {
      const c = cards.get(h.id);
      if (!c) continue;
      const cat = c.categoryId ? (db.prepare('SELECT region, genre, is_adult FROM categories WHERE id = ?').get(c.categoryId) as any) : undefined;
      if (cat?.is_adult) continue;
      if (a.kids && !['kids', 'animation'].includes(cat?.genre ?? '')) continue;
      const key = `${c.kind}|${c.title.toLowerCase()}|${c.year ?? ''}|${c.kind === 'live' ? c.id : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(c);
      if (results.length >= 60) break;
    }
    attachNowNext(db, results);
    return {
      query: text,
      results,
      categories: catRows.filter((c) => !a.kids || ['kids', 'animation'].includes(c.genre)).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      suggestions: search.index.suggest(text, 6, visible),
    };
  });

  app.post('/api/search/history', async (req) => {
    const p = needProfile(req);
    const { query } = body<{ query: string }>(req);
    if (typeof query === 'string' && query.trim().length >= 2) {
      db.prepare('INSERT INTO search_history (profile_id, query, at) VALUES (?, ?, ?) ON CONFLICT(profile_id, query) DO UPDATE SET at = excluded.at').run(p.id, query.trim().slice(0, 80), Date.now());
    }
    return { ok: true };
  });

  app.delete('/api/search/history', async (req) => {
    const p = needProfile(req);
    db.prepare('DELETE FROM search_history WHERE profile_id = ?').run(p.id);
    return { ok: true };
  });

  /* ---------------- personal data ---------------- */

  app.get('/api/me/list', async (req) => ({ items: myList(db, needProfile(req).id) }));
  app.get('/api/me/continue', async (req) => ({ items: continueWatching(db, needProfile(req).id) }));

  const matchKeyOf = (id: string): { kind: string; matchKey: string | null; categoryId?: string; seriesId?: string; genres?: string } | null => {
    const parsed = parseContentId(id);
    if (!parsed) return null;
    const table = { live: 'channels', movie: 'movies', series: 'series', episode: 'episodes', category: '' }[parsed.kind];
    if (!table) return null;
    if (parsed.kind === 'episode') {
      const r = db.prepare('SELECT e.series_id, s.category_id, s.genres FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?').get(id) as any;
      return r ? { kind: 'episode', matchKey: null, seriesId: r.series_id, categoryId: r.category_id ?? undefined, genres: r.genres ?? undefined } : null;
    }
    const r = db.prepare(`SELECT match_key, category_id${parsed.kind === 'live' ? '' : ', genres'} FROM ${table} WHERE id = ?`).get(id) as any;
    return r ? { kind: parsed.kind, matchKey: r.match_key, categoryId: r.category_id ?? undefined, genres: r.genres ?? undefined } : null;
  };

  app.put('/api/me/list/:id', async (req) => {
    const p = needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const m = matchKeyOf(id);
    if (!m || m.kind === 'episode') throw new HttpError(404, 'Not found.');
    db.prepare('INSERT OR IGNORE INTO favorites (profile_id, content_id, kind, match_key, added_at) VALUES (?, ?, ?, ?, ?)').run(p.id, id, m.kind, m.matchKey, Date.now());
    return { inList: true };
  });

  app.delete('/api/me/list/:id', async (req) => {
    const p = needProfile(req);
    db.prepare('DELETE FROM favorites WHERE profile_id = ? AND content_id = ?').run(p.id, (req.params as { id: string }).id);
    return { inList: false };
  });

  /** Save playback position. Called every few seconds by the player and on exit. */
  app.put('/api/me/progress/:id', async (req) => {
    const p = needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const { position, duration } = body<{ position: number; duration: number }>(req);
    const m = matchKeyOf(id);
    if (!m) throw new HttpError(404, 'Not found.');
    const now = Date.now();
    if (m.kind === 'live') {
      // Live: record a history entry (for "recently watched channels"), at most once per 10 min.
      const recent = db.prepare(`SELECT id FROM history WHERE profile_id = ? AND content_id = ? AND watched_at > ?`).get(p.id, id, now - 10 * 60_000) as { id: number } | undefined;
      if (recent) db.prepare('UPDATE history SET watched_at = ? WHERE id = ?').run(now, recent.id);
      else db.prepare('INSERT INTO history (profile_id, content_id, kind, category_id, completion, watched_at) VALUES (?, ?, ?, ?, 0, ?)').run(p.id, id, 'live', m.categoryId ?? null, now);
      return { ok: true };
    }
    if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration <= 0) throw bad('Invalid position.');
    const finished = position / duration > 0.93 || duration - position < 90;
    db.prepare(
      `INSERT INTO progress (profile_id, content_id, kind, series_id, match_key, position_sec, duration_sec, finished, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(profile_id, content_id) DO UPDATE SET position_sec = excluded.position_sec, duration_sec = excluded.duration_sec, finished = excluded.finished, updated_at = excluded.updated_at`,
    ).run(p.id, id, m.kind, m.seriesId ?? null, m.matchKey, position, duration, finished ? 1 : 0, now);
    const completion = Math.min(1, position / duration);
    const recent = db.prepare(`SELECT id FROM history WHERE profile_id = ? AND content_id = ? AND watched_at > ?`).get(p.id, id, now - 6 * 3_600_000) as { id: number } | undefined;
    if (recent) db.prepare('UPDATE history SET watched_at = ?, completion = MAX(completion, ?) WHERE id = ?').run(now, completion, recent.id);
    else
      db.prepare('INSERT INTO history (profile_id, content_id, kind, category_id, genres, completion, watched_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        p.id,
        id,
        m.kind,
        m.categoryId ?? null,
        m.genres ?? null,
        completion,
        now,
      );
    return { ok: true, finished };
  });

  app.delete('/api/me/progress/:id', async (req) => {
    const p = needProfile(req);
    db.prepare('DELETE FROM progress WHERE profile_id = ? AND content_id = ?').run(p.id, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/me/history/clear', async (req) => {
    const p = needProfile(req);
    db.prepare('DELETE FROM history WHERE profile_id = ?').run(p.id);
    db.prepare('DELETE FROM progress WHERE profile_id = ?').run(p.id);
    return { ok: true };
  });

  app.post('/api/me/recommendations/reset', async (req) => {
    const p = needProfile(req);
    setSetting(db, `recs_reset:${p.id}`, Date.now());
    return { ok: true };
  });

  /** The player reports the resolution it actually decoded. Only this drives quality badges. */
  app.post('/api/me/quality/:id', async (req) => {
    needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    const { width, height } = body<{ width: number; height: number }>(req);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || height > 8640) throw bad('Invalid size.');
    db.prepare('INSERT INTO verified_quality (content_id, width, height, measured_at) VALUES (?, ?, ?, ?) ON CONFLICT(content_id) DO UPDATE SET width = excluded.width, height = excluded.height, measured_at = excluded.measured_at').run(
      id,
      Math.round(width),
      Math.round(height),
      Date.now(),
    );
    return { ok: true };
  });

  /* ---------------- playback ---------------- */

  app.get('/api/play/:id', async (req) => {
    const p = needProfile(req);
    const { id } = req.params as { id: string };
    const parsed = assertOwnsContent(req, id);
    if (!['live', 'movie', 'episode'].includes(parsed.kind)) throw new HttpError(404, 'Not playable.');
    let sources;
    try {
      sources = playbackSources(db, id);
    } catch (err) {
      if (err instanceof PlaybackError) throw new HttpError(err.code === 'consent' ? 409 : 404, err.message, { code: err.code });
      throw err;
    }
    const card = lookupCards(db, [id]).get(id);
    if (card?.categoryId) assertAllowed(req, card);
    const prog = db.prepare('SELECT position_sec, duration_sec, finished FROM progress WHERE profile_id = ? AND content_id = ?').get(p.id, id) as any;
    let nextEpisode: Card | undefined;
    let episodeInfo: { season: number; episode: number; title: string } | undefined;
    if (parsed.kind === 'episode') {
      const e = db.prepare('SELECT series_id, season, episode, title, runtime_sec FROM episodes WHERE id = ?').get(id) as any;
      if (e) {
        episodeInfo = { season: e.season, episode: e.episode, title: e.title };
        const n = db
          .prepare('SELECT id FROM episodes WHERE series_id = ? AND (season > ? OR (season = ? AND episode > ?)) ORDER BY season, episode LIMIT 1')
          .get(e.series_id, e.season, e.season, e.episode) as { id: string } | undefined;
        if (n) nextEpisode = lookupCards(db, [n.id]).get(n.id);
      }
    }
    const live = parsed.kind === 'live' ? channelDetails(db, id) : null;
    const verified = db.prepare('SELECT width, height FROM verified_quality WHERE content_id = ?').get(id) as any;
    return {
      id,
      kind: parsed.kind,
      title: card?.title ?? '',
      subtitle: card?.subtitle,
      artwork: card?.backdrop ?? card?.poster ?? card?.logo,
      seriesId: card?.seriesId,
      sources,
      resumeAt: prog && !prog.finished && prog.position_sec > 30 ? prog.position_sec : 0,
      episode: episodeInfo,
      nextEpisode,
      live: live && {
        now: live.now,
        next: live.next,
        number: live.number,
        logo: live.logo,
        alternates: live.alternates,
        ...neighbourChannels(db, id),
      },
      verified: verified ? { width: verified.width, height: verified.height } : undefined,
      autoplayNext: prefsOf(p).autoplayNext !== false,
      onlineSubtitles: parsed.kind !== 'live' && subtitles.configured(),
      subtitleLang: prefsOf(p).subtitleLang,
    };
  });

  /* ---------------- online subtitles (OpenSubtitles) ---------------- */

  // Everyone on the server shares the owner's OpenSubtitles allowance, so cap each account.
  const subtitleUse = new Map<string, number[]>();
  const limitSubtitles = (req: FastifyRequest, kind: 'search' | 'download') => {
    const key = `${kind}:${needSession(req).accountId}`;
    const now = Date.now();
    const recent = (subtitleUse.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= (kind === 'search' ? 120 : 40)) throw new HttpError(429, 'Too many subtitle requests. Try again in a while.');
    recent.push(now);
    subtitleUse.set(key, recent);
  };

  const subtitleTarget = (id: string, kind: string): SearchTarget => {
    if (kind === 'movie') {
      const m = db.prepare('SELECT title, year, tmdb_id FROM movies WHERE id = ?').get(id) as { title: string; year: number | null; tmdb_id: string | null } | undefined;
      if (m) return { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdb_id };
    } else if (kind === 'episode') {
      const e = db
        .prepare('SELECT e.season, e.episode, s.title, s.year, s.tmdb_id FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?')
        .get(id) as { season: number; episode: number; title: string; year: number | null; tmdb_id: string | null } | undefined;
      if (e) return { kind: 'episode', seriesTitle: e.title, year: e.year, seriesTmdbId: e.tmdb_id, season: e.season, episode: e.episode };
    }
    throw new HttpError(404, 'Online subtitles aren’t available for this title.');
  };

  app.get('/api/subtitles/search', async (req) => {
    const p = needProfile(req);
    const { id, lang } = q<{ id?: string; lang?: string }>(req);
    if (!id) throw bad('Choose a title.');
    const parsed = assertOwnsContent(req, id);
    const card = lookupCards(db, [id]).get(id);
    if (card?.categoryId) assertAllowed(req, card);
    const target = subtitleTarget(id, parsed.kind);
    limitSubtitles(req, 'search');
    const language = lang ?? prefsOf(p).subtitleLang ?? 'en';
    const { results, match } = await subtitles.search(target, language);
    return { language: language || 'all', match, results };
  });

  app.post('/api/subtitles/download', async (req) => {
    needProfile(req);
    const fileId = Number(body<{ fileId?: unknown }>(req).fileId);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw bad('Choose subtitles to download.');
    if (!subtitles.cached(fileId)) limitSubtitles(req, 'download');
    const result = await subtitles.download(fileId);
    return { url: `/api/subtitles/file/${fileId}.vtt`, remaining: result.remaining };
  });

  app.get('/api/subtitles/file/:name', async (req, reply) => {
    needSession(req);
    const m = /^(\d{1,12})\.vtt$/.exec((req.params as { name: string }).name);
    const vtt = m ? subtitles.cached(Number(m[1])) : null;
    if (!vtt) throw new HttpError(404, 'Those subtitles aren’t downloaded. Choose them again from the subtitles menu.');
    return reply.type('text/vtt; charset=utf-8').header('Cache-Control', 'private, max-age=86400').send(vtt);
  });

  app.get('/api/settings/subtitles', async (req) => {
    needOwner(req);
    return subtitles.status();
  });

  app.put('/api/settings/subtitles', async (req) => {
    needOwner(req);
    needElevation(req);
    const b = body<{ apiKey?: unknown; username?: unknown; password?: unknown }>(req);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    return subtitles.save({ apiKey: text(b.apiKey, 200), username: text(b.username, 100), password: text(b.password, 200) });
  });

  app.delete('/api/settings/subtitles', async (req) => {
    needOwner(req);
    needElevation(req);
    subtitles.clear();
    return { configured: false };
  });

  /** Recovery helper: is the network/provider/auth OK? Lets the player show a useful message. */
  app.get('/api/play/:id/diagnose', async (req) => {
    needProfile(req);
    const parsed = assertOwnsContent(req, (req.params as { id: string }).id);
    const status = await providerAuthStatus(db, parsed.providerId);
    const row = getProvider(db, parsed.providerId);
    const account = row?.account_json ? JSON.parse(row.account_json) : undefined;
    return { provider: status, maxConnections: account?.maxConnections, activeConnections: account?.activeConnections };
  });

  const sessionKey = (req: FastifyRequest) => needSession(req).tokenHash;

  app.get('/api/stream/live/:id/index.m3u8', async (req, reply) => {
    needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    reply.hijack();
    await handleLive(db, { req: req.raw, res: reply.raw }, id, 'm3u8', sessionKey(req));
  });
  app.get('/api/stream/live/:id/stream.ts', async (req, reply) => {
    needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    reply.hijack();
    await handleLive(db, { req: req.raw, res: reply.raw }, id, 'ts', sessionKey(req));
  });
  app.get('/api/stream/h/:token', async (req, reply) => {
    const s = needSession(req);
    reply.hijack();
    await handleHlsToken(db, { req: req.raw, res: reply.raw }, (req.params as { token: string }).token, (providerId) => providerOwnedBy(db, providerId, s.accountId));
  });
  app.get('/api/stream/vod/:id', async (req, reply) => {
    needProfile(req);
    const { id } = req.params as { id: string };
    assertOwnsContent(req, id);
    reply.hijack();
    await handleVod(db, { req: req.raw, res: reply.raw }, id, sessionKey(req));
  });

  app.get('/api/img', async (req, reply) => {
    needSession(req);
    const { u } = q<{ u?: string }>(req);
    if (!u) throw bad('Missing url.');
    reply.hijack();
    await serveImage(u, reply.raw);
  });

  /* ---------------- settings & diagnostics ---------------- */

  app.get('/api/settings', async (req) => {
    const s = needSession(req);
    const own = providerSql({ providers: accountProviderIds(db, s.accountId) }, 't');
    return {
      hideAdult: getSetting(db, 'hide_adult', true),
      images: s.role === 'owner' ? imageCacheStats() : undefined,
      epg: (db.prepare(`SELECT COUNT(*) AS n, MIN(start) AS first, MAX(stop) AS last FROM programmes t WHERE ${own}`).get() as any) ?? {},
    };
  });

  app.post('/api/settings/cache/:which', async (req) => {
    const s = needSession(req);
    needElevation(req);
    const { which } = req.params as { which: string };
    const own = providerSql({ providers: listProviders(db, s.accountId).map((p) => p.id) }, 't');
    if (which === 'images') {
      needOwner(req);
      return { cleared: clearImageCache() };
    }
    if (which === 'epg') {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM programmes t WHERE ${own}`).get() as { n: number }).n;
      db.prepare(`DELETE FROM programmes AS t WHERE ${own}`).run();
      return { cleared: n };
    }
    if (which === 'metadata') {
      db.prepare(`UPDATE movies AS t SET details_at = NULL, details_json = NULL WHERE ${own}`).run();
      db.prepare(`UPDATE series AS t SET details_at = NULL WHERE ${own}`).run();
      return { cleared: true };
    }
    throw bad('Unknown cache.');
  });

  app.get('/api/diagnostics', async (req) => {
    const s = needSession(req);
    const mem = process.memoryUsage();
    return {
      version: '0.2.0',
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) },
      searchIndex: { documents: search.index.size, builtAt: search.builtAt },
      catalog: catalogCounts(accountProviderIds(db, s.accountId)),
      sync: syncPublic(s.accountId),
    };
  });

  /* ---------------- web app ---------------- */

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
