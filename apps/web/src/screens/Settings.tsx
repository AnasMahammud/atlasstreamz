import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Profile, type ProfilePrefs, type Provider, type SubtitleSettings, type SyncSummary } from '../lib/api.ts';
import { useStatus } from '../lib/queries.ts';
import { toast, useUi } from '../lib/store.ts';
import { focusFirst } from '../lib/focus.ts';
import { Dialog, Segmented, Switch } from '../components/Primitives.tsx';
import { PinPad } from '../components/PinPad.tsx';
import { Avatar } from '../components/Brand.tsx';
import { IconInfo, IconLogout, IconPlay, IconRefresh, IconSliders, IconSource, IconStorage, IconSubtitles, IconTrash, IconUser, IconUsers } from '../components/Icons.tsx';
import { ProviderForm } from './settings/ProviderForm.tsx';
import { atlasNative } from './Player.tsx';

const SECTIONS = [
  { to: 'account', label: 'Account', icon: IconUser },
  { to: 'playback', label: 'Playback', icon: IconPlay },
  { to: 'appearance', label: 'Appearance', icon: IconSliders },
  { to: 'sources', label: 'Content Sources', icon: IconSource },
  { to: 'subtitles', label: 'Subtitles', icon: IconSubtitles, ownerOnly: true },
  { to: 'members', label: 'Members', icon: IconUsers, ownerOnly: true },
  { to: 'storage', label: 'Storage', icon: IconStorage },
  { to: 'about', label: 'About', icon: IconInfo },
];

/* ---------------- elevation (PIN / owner password for protected changes) ---------------- */

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function useElevation(): { run: Run; dialog: ReactNode } {
  const { data: status } = useStatus();
  const [pending, setPending] = useState<null | { resolve: (ok: boolean) => void }>(null);
  const [error, setError] = useState<string | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const profile = status?.profile;

  const ask = () =>
    new Promise<boolean>((resolve) => {
      setError(null);
      setPassword('');
      setUsePassword(!profile?.hasPin);
      setPending({ resolve });
    });

  const run: Run = useCallback(
    async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError && err.data.code === 'elevation_required') {
          if (await ask()) return fn();
          return undefined;
        }
        throw err;
      }
    },
    [profile?.hasPin], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const submit = async (body: { pin?: string; password?: string }) => {
    try {
      await api.post('/api/auth/elevate', body);
      pending?.resolve(true);
      setPending(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t confirm.');
    }
  };

  const dialog = (
    <Dialog
      open={!!pending}
      onClose={() => {
        pending?.resolve(false);
        setPending(null);
      }}
      title="Confirm it’s you"
    >
      {!usePassword && profile?.hasPin ? (
        <div style={{ display: 'grid', justifyItems: 'center', gap: '0.8rem' }}>
          <PinPad allowVariable onSubmit={(pin) => submit({ pin })} error={error} label={`${profile.name}’s PIN`} />
          <button className="glass-btn sm" onClick={() => setUsePassword(true)}>
            Use account password instead
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ password });
          }}
          style={{ display: 'grid', gap: '1rem', marginTop: '0.8rem' }}
        >
          <div className="field">
            <label htmlFor="elev-pw">Account password</label>
            <input id="elev-pw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-autofocus />
            {error && <span className="error">{error}</span>}
          </div>
          <button className="glass-btn primary" type="submit" disabled={!password}>
            Confirm
          </button>
        </form>
      )}
    </Dialog>
  );
  return { run, dialog };
}

/* ---------------- shell ---------------- */

export default function Settings() {
  const ref = useRef<HTMLDivElement>(null);
  const { data: status } = useStatus();
  const isOwner = status?.account?.role === 'owner';
  const { run, dialog } = useElevation();
  useEffect(() => focusFirst(ref.current ?? document), []);
  return (
    <main className="page settings-page" ref={ref}>
      <h1 className="t-headline" style={{ marginBottom: '1.5rem' }}>
        Settings
      </h1>
      <div className="settings-layout">
        <nav className="settings-nav glass" aria-label="Settings sections" data-focus-zone="settings-nav">
          {SECTIONS.filter((s) => !s.ownerOnly || isOwner).map((s, i) => (
            <NavLink key={s.to} to={s.to} className={({ isActive }) => `settings-link ${isActive ? 'active' : ''}`} data-autofocus={i === 0 ? true : undefined}>
              <s.icon />
              {s.label}
            </NavLink>
          ))}
        </nav>
        <section className="settings-panel" data-focus-zone="settings-panel">
          <Routes>
            <Route index element={<Navigate to="account" replace />} />
            <Route path="account" element={<AccountSection run={run} />} />
            <Route path="playback" element={<PlaybackSection />} />
            <Route path="appearance" element={<AppearanceSection />} />
            <Route path="sources" element={<SourcesSection run={run} />} />
            <Route path="storage" element={<StorageSection run={run} />} />
            <Route path="about" element={<AboutSection />} />
            {isOwner && <Route path="members" element={<MembersSection run={run} />} />}
            {isOwner && <Route path="subtitles" element={<SubtitlesSection run={run} />} />}
          </Routes>
        </section>
      </div>
      {dialog}
    </main>
  );
}

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="sr-text">
        <div className="t-title">{title}</div>
        {desc && <div className="t-caption">{desc}</div>}
      </div>
      {children && <div className="sr-control">{children}</div>}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      {title && <h2 className="t-eyebrow">{title}</h2>}
      <div className="settings-card glass">{children}</div>
    </div>
  );
}

/** Save a pref on the current profile, optimistically. */
function usePrefs() {
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const profile = status?.profile;
  const save = async (patch: Partial<ProfilePrefs>) => {
    if (!profile) return;
    qc.setQueryData(['status'], (s: any) => (s?.profile ? { ...s, profile: { ...s.profile, prefs: { ...s.profile.prefs, ...patch } } } : s));
    try {
      await api.patch(`/api/profiles/${profile.id}`, { prefs: patch });
    } catch (err) {
      void qc.invalidateQueries({ queryKey: ['status'] });
      // Protected changes are retried by the caller's elevation wrapper.
      if (err instanceof ApiError && err.data.code === 'elevation_required') throw err;
      toast(err instanceof ApiError ? err.message : 'Couldn’t save', { tone: 'error' });
    }
    void qc.invalidateQueries({ queryKey: ['status'] });
    void qc.invalidateQueries({ queryKey: ['home'] });
  };
  return { profile, prefs: profile?.prefs ?? {}, save };
}

/* ---------------- Account ---------------- */

function AccountSection({ run }: { run: Run }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profile, prefs, save } = usePrefs();
  const { data: sessions, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: ({ signal }) => api.get<Array<{ id: string; current: boolean; createdAt: number; lastSeenAt: number; device: string }>>('/api/sessions', signal),
  });
  const [pinOpen, setPinOpen] = useState(false);

  const signOut = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    navigate('/login', { replace: true });
  };

  const { data: status } = useStatus();
  const [pwOpen, setPwOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <>
      {status?.account && (
        <Group title="Your account">
          <Row title={status.account.email} desc={status.account.role === 'owner' ? 'Server owner — you manage members and sign-ups.' : 'Member account — your profiles, history and sources are yours alone.'} />
          <Row title="Password" desc="Changing it signs out your other devices.">
            <button className="glass-btn sm" onClick={() => setPwOpen(true)}>
              Change password
            </button>
          </Row>
          {status.account.role !== 'owner' && (
            <Row title="Delete account" desc="Permanently removes your profiles, history and content sources from this server.">
              <button className="glass-btn sm danger" onClick={() => setDeleteOpen(true)}>
                Delete
              </button>
            </Row>
          )}
        </Group>
      )}
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <DeleteAccountDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} />
      {profile && (
        <Group title="This profile">
          <Row title={profile.name} desc={profile.isKids ? 'Kids profile' : 'Standard profile'}>
            <Avatar avatar={profile.avatar} name={profile.name} size={48} />
          </Row>
          <Row title="Profile PIN" desc={profile.hasPin ? 'A PIN is required to open this profile.' : 'Anyone on this device can open this profile.'}>
            <button className="glass-btn sm" onClick={() => setPinOpen(true)}>
              {profile.hasPin ? 'Change PIN' : 'Set PIN'}
            </button>
          </Row>
          <Row title="Lock Settings with PIN" desc="Ask for this profile’s PIN before changing sources, profiles or storage.">
            <Switch checked={!!prefs.lockSettings} onChange={(v) => (profile.hasPin || !v ? void run(() => save({ lockSettings: v })) : toast('Set a PIN first.'))} label="Lock settings" />
          </Row>
          <Row title="Switch profile">
            <button className="glass-btn sm" onClick={() => navigate('/profiles')}>
              Profiles
            </button>
          </Row>
        </Group>
      )}
      <Group title="Devices signed in">
        {sessions?.map((s) => (
          <Row key={s.id} title={deviceName(s.device)} desc={`${s.current ? 'This device · ' : ''}last active ${new Date(s.lastSeenAt).toLocaleString()}`}>
            {!s.current && (
              <button
                className="glass-btn sm danger"
                onClick={() =>
                  run(async () => {
                    await api.del(`/api/sessions/${s.id}`);
                    void refetch();
                  })
                }
              >
                Sign out
              </button>
            )}
          </Row>
        ))}
        <Row title="Sign out of this device" desc="You’ll need your email and password to sign back in.">
          <button className="glass-btn sm" onClick={signOut}>
            <IconLogout /> Sign out
          </button>
        </Row>
      </Group>
      {profile && <PinDialog open={pinOpen} profile={profile} onClose={() => setPinOpen(false)} />}
    </>
  );
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setError('Use at least 8 characters.');
    try {
      await api.post('/api/account/password', { currentPassword: current, newPassword: next });
      toast('Password changed. Other devices were signed out.', { tone: 'success' });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t change the password.');
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Change password">
      <form onSubmit={submit} style={{ display: 'grid', gap: '1rem', marginTop: '0.8rem' }}>
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-autofocus />
        </div>
        <div className="field">
          <label htmlFor="pw-next">New password</label>
          <input id="pw-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {error && <span className="error">{error}</span>}
        </div>
        <button className="glass-btn primary" type="submit" disabled={!current || !next}>
          Change password
        </button>
      </form>
    </Dialog>
  );
}

function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.del('/api/account', { password: pw });
      qc.clear();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t delete the account.');
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Delete your account?">
      <form onSubmit={submit} style={{ display: 'grid', gap: '1rem', marginTop: '0.6rem' }}>
        <p className="t-body">Your profiles, watch history, My List and content sources are removed from this server. This can’t be undone.</p>
        <div className="field">
          <label htmlFor="del-pw">Password</label>
          <input id="del-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus />
          {error && <span className="error">{error}</span>}
        </div>
        <div className="actions">
          <button type="button" className="glass-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="glass-btn danger" disabled={!pw}>
            Delete account
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---------------- Members (server owner) ---------------- */

interface AdminData {
  registration: 'closed' | 'invite' | 'open';
  accounts: Array<{ id: string; email: string; role: 'owner' | 'member'; disabled: boolean; createdAt: number; lastLoginAt?: number; profiles: number; sources: number }>;
  invites: Array<{ id: string; label?: string; createdAt: number; expiresAt: number; usedAt?: number; usedBy?: string; status: 'active' | 'used' | 'expired' }>;
}

function MembersSection({ run }: { run: Run }) {
  const { data, refetch } = useQuery({ queryKey: ['admin'], queryFn: ({ signal }) => api.get<AdminData>('/api/admin/accounts', signal) });
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ code: string; expiresAt: number } | null>(null);
  const [removing, setRemoving] = useState<AdminData['accounts'][number] | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const r = await run(fn);
      if (r !== undefined && ok) toast(ok, { tone: 'success' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong', { tone: 'error' });
    }
    void refetch();
    void qc.invalidateQueries({ queryKey: ['status'] });
  };
  const link = created ? `${location.origin}/register?invite=${created.code}` : '';
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', { tone: 'success' });
    } catch {
      toast('Copy it manually from the box', { tone: 'error' });
    }
  };
  return (
    <>
      <Group title="Who can sign up">
        <Row
          title="New accounts"
          desc="Every account gets its own profiles, history and content sources, and nobody can see another account’s channels. Video is streamed through this server, so each member also uses its bandwidth."
        >
          <Segmented
            label="Sign-ups"
            value={data?.registration ?? 'invite'}
            onChange={(mode) => act(() => api.put('/api/admin/registration', { mode }), mode === 'open' ? 'Anyone with the link can now sign up' : mode === 'invite' ? 'Sign-up now needs an invite' : 'Sign-ups closed')}
            options={[
              { value: 'closed', label: 'Closed' },
              { value: 'invite', label: 'Invite only' },
              { value: 'open', label: 'Open' },
            ]}
          />
        </Row>
      </Group>

      <Group title="Invitations">
        <form
          className="settings-row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await run(() => api.post<{ code: string; expiresAt: number }>('/api/admin/invites', { label }));
              if (r) {
                setCreated(r);
                setLabel('');
              }
              return r;
            });
          }}
        >
          <input className="input" style={{ flex: 1 }} placeholder="Who is it for? (optional)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Invite label" />
          <button className="glass-btn sm primary" type="submit">
            Create invite
          </button>
        </form>
        {created && (
          <div className="invite-created">
            <div className="t-caption">Single-use, expires {new Date(created.expiresAt).toLocaleDateString()}. Send this link, or the code on its own:</div>
            <div className="invite-box">
              <code>{link}</code>
              <button className="glass-btn sm" onClick={() => copy(link)}>
                Copy link
              </button>
            </div>
            <div className="invite-box">
              <code className="invite-code">{created.code}</code>
              <button className="glass-btn sm" onClick={() => copy(created.code)}>
                Copy code
              </button>
            </div>
          </div>
        )}
        {data?.invites.map((i) => (
          <Row key={i.id} title={i.label ?? 'Invite'} desc={i.status === 'used' ? `Used by ${i.usedBy ?? 'a deleted account'} on ${new Date(i.usedAt!).toLocaleDateString()}` : i.status === 'expired' ? 'Expired' : `Active until ${new Date(i.expiresAt).toLocaleDateString()}`}>
            {i.status === 'active' && (
              <button className="glass-btn sm" onClick={() => act(() => api.del(`/api/admin/invites/${i.id}`), 'Invite withdrawn')}>
                Withdraw
              </button>
            )}
          </Row>
        ))}
      </Group>

      <Group title="Accounts">
        {data?.accounts.map((a) => (
          <Row
            key={a.id}
            title={`${a.email}${a.role === 'owner' ? ' · owner' : ''}${a.disabled ? ' · disabled' : ''}`}
            desc={`${a.profiles} profile${a.profiles === 1 ? '' : 's'} · ${a.sources} source${a.sources === 1 ? '' : 's'} · joined ${new Date(a.createdAt).toLocaleDateString()}${a.lastLoginAt ? ` · last sign-in ${new Date(a.lastLoginAt).toLocaleDateString()}` : ''}`}
          >
            {a.role !== 'owner' && (
              <>
                <button className="glass-btn sm" onClick={() => act(() => api.patch(`/api/admin/accounts/${a.id}`, { disabled: !a.disabled }), a.disabled ? 'Account enabled' : 'Account disabled and signed out')}>
                  {a.disabled ? 'Enable' : 'Disable'}
                </button>
                <button className="glass-btn sm danger" onClick={() => setRemoving(a)}>
                  Delete
                </button>
              </>
            )}
          </Row>
        ))}
      </Group>

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Delete ${removing?.email ?? ''}?`}
        actions={
          <>
            <button className="glass-btn" onClick={() => setRemoving(null)} data-autofocus>
              Cancel
            </button>
            <button
              className="glass-btn danger"
              onClick={() => {
                const id = removing!.id;
                setRemoving(null);
                void act(() => api.del(`/api/admin/accounts/${id}`), 'Account deleted');
              }}
            >
              Delete account
            </button>
          </>
        }
      >
        <p className="t-body">Their profiles, history and content sources are removed from this server. This can’t be undone.</p>
      </Dialog>
    </>
  );
}

function deviceName(ua: string): string {
  if (/Android TV|AFT|BRAVIA|GoogleTV/i.test(ua)) return 'Android TV / Fire TV';
  if (/iPhone|iPad/i.test(ua)) return /iPad/.test(ua) ? 'iPad' : 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return `Windows · ${/Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : 'Browser'}`;
  if (/Mac OS/i.test(ua)) return `Mac · ${/Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'}`;
  return ua ? 'Browser' : 'Unknown device';
}

function PinDialog({ open, profile, onClose }: { open: boolean; profile: Profile; onClose: () => void }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<'current' | 'new' | 'confirm'>('current');
  const [current, setCurrent] = useState('');
  const [first, setFirst] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setStage(profile.hasPin ? 'current' : 'new');
      setError(null);
      setCurrent('');
      setFirst('');
    }
  }, [open, profile.hasPin]);
  const finish = async (pin: string | null) => {
    try {
      await api.post(`/api/profiles/${profile.id}/pin`, { currentPin: current || undefined, newPin: pin });
      toast(pin ? 'PIN updated' : 'PIN removed', { tone: 'success' });
      void qc.invalidateQueries({ queryKey: ['status'] });
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t update the PIN.');
      setStage(profile.hasPin ? 'current' : 'new');
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={profile.hasPin ? 'Change PIN' : 'Set a PIN'}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: '0.8rem', marginTop: '0.6rem' }}>
        {stage === 'current' && (
          <PinPad
            key="cur"
            allowVariable
            label="Current PIN"
            error={error}
            onSubmit={(p) => {
              setCurrent(p);
              setError(null);
              setStage('new');
            }}
          />
        )}
        {stage === 'new' && (
          <PinPad
            key="new"
            allowVariable
            label="New PIN (4–6 digits)"
            error={error}
            onSubmit={(p) => {
              setFirst(p);
              setError(null);
              setStage('confirm');
            }}
          />
        )}
        {stage === 'confirm' && (
          <PinPad
            key="confirm"
            length={first.length}
            label="Enter it again"
            error={error}
            onSubmit={(p) => {
              if (p !== first) {
                setError('PINs didn’t match. Try again.');
                setStage('new');
                return;
              }
              void finish(p);
            }}
          />
        )}
        {profile.hasPin && stage !== 'current' && (
          <button className="glass-btn sm danger" onClick={() => finish(null)}>
            Remove PIN instead
          </button>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------- Playback ---------------- */

const LANGS = [
  ['', 'Provider default'],
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['pl', 'Polish'],
];

function PlaybackSection() {
  const { prefs, save } = usePrefs();
  const style = useUi((s) => s.subtitleStyle);
  const setStyle = useUi((s) => s.setSubtitleStyle);
  return (
    <>
      <Group title="Playback">
        <Row title="Auto-play next episode" desc="Starts the next episode after a 10-second countdown.">
          <Switch checked={prefs.autoplayNext !== false} onChange={(v) => save({ autoplayNext: v })} label="Auto-play next episode" />
        </Row>
        <Row title="Data saver" desc="Caps adaptive streams at 720p. Single-quality streams are unaffected.">
          <Switch checked={!!prefs.dataSaver} onChange={(v) => save({ dataSaver: v })} label="Data saver" />
        </Row>
        <Row title="Quality" desc="ATLAS picks the best quality your connection and device can sustain. Quality is only labelled once it has been measured during playback." />
        <Row title="Hardware acceleration" desc="Decoding uses your device’s hardware through the browser. Controlled by the browser on web; native apps manage it directly." />
      </Group>
      <Group title="Languages">
        <Row title="Preferred audio">
          <select className="input select" value={prefs.audioLang ?? ''} onChange={(e) => save({ audioLang: e.target.value || undefined })}>
            {LANGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Preferred subtitles">
          <select className="input select" value={prefs.subtitleLang ?? ''} onChange={(e) => save({ subtitleLang: e.target.value || undefined })}>
            {[['', 'Off'], ...LANGS.slice(1)].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Subtitle style">
        <Row title="Text size">
          <Segmented label="Text size" value={String(style.size)} onChange={(v) => setStyle({ size: Number(v) })} options={['80', '100', '125', '150'].map((v) => ({ value: v, label: `${v}%` }))} />
        </Row>
        <Row title="Background">
          <Segmented
            label="Background"
            value={String(style.background)}
            onChange={(v) => setStyle({ background: Number(v) })}
            options={[
              { value: '0', label: 'None' },
              { value: '0.35', label: 'Light' },
              { value: '0.55', label: 'Medium' },
              { value: '0.85', label: 'Solid' },
            ]}
          />
        </Row>
        <div className="subtitle-preview">
          <span style={{ fontSize: `${(style.size / 100) * 1.4}rem`, background: `rgba(0,0,0,${style.background})` }}>The quick brown fox jumps over the lazy dog.</span>
        </div>
      </Group>
    </>
  );
}

/* ---------------- Subtitles (OpenSubtitles, owner only) ---------------- */

function SubtitlesSection({ run }: { run: Run }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['subtitle-settings'], queryFn: () => api.get<SubtitleSettings>('/api/settings/subtitles') });
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = !!data?.configured;
  const user = username ?? data?.username ?? '';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await run(() => api.put<SubtitleSettings>('/api/settings/subtitles', { apiKey, username: user, password }));
      if (next) {
        qc.setQueryData(['subtitle-settings'], next);
        setApiKey('');
        setPassword('');
        setUsername(null);
        toast('OpenSubtitles connected', { tone: 'success' });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save.');
    } finally {
      setSaving(false);
    }
  };

  const turnOff = async () => {
    const done = await run(() => api.del('/api/settings/subtitles'));
    if (done) {
      qc.setQueryData(['subtitle-settings'], { configured: false });
      toast('Online subtitles turned off');
    }
  };

  const status = !data
    ? '…'
    : !configured
      ? 'Off. Viewers can still load subtitle files from their own device.'
      : [
          data.username ? `Connected as ${data.username}` : 'Connected with an API key only',
          data.remaining !== undefined && data.allowed !== undefined && `${data.remaining} of ${data.allowed} downloads left today`,
          data.error,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <>
      <Group title="OpenSubtitles">
        <Row title="Online subtitles" desc={status}>
          {configured && (
            <button className="glass-btn sm" onClick={turnOff}>
              Turn off
            </button>
          )}
        </Row>
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: 'grid', gap: '1rem', padding: '1rem 1.1rem 1.2rem' }}
        >
          <div className="field">
            <label htmlFor="os-key">API key</label>
            <input id="os-key" className="input" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={configured ? 'Saved. Leave blank to keep it.' : 'From opensubtitles.com → API consumers'} />
          </div>
          <div className="field">
            <label htmlFor="os-user">OpenSubtitles username (optional)</label>
            <input id="os-user" className="input" autoComplete="off" spellCheck={false} value={user} onChange={(e) => setUsername(e.target.value)} />
            {user.includes('@') ? (
              <span className="error">Use your OpenSubtitles username, not your email address. It’s shown on your opensubtitles.com profile.</span>
            ) : (
              <span className="hint">Your username, not your email address.</span>
            )}
          </div>
          <div className="field">
            <label htmlFor="os-pass">OpenSubtitles password</label>
            <input id="os-pass" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={configured && data?.username && user === data.username ? 'Saved. Leave blank to keep it.' : ''} disabled={!user} />
            {error && <span className="error">{error}</span>}
          </div>
          <div>
            <button className="glass-btn primary" type="submit" disabled={saving || (!configured && !apiKey.trim()) || user.includes('@')}>
              {saving ? 'Checking with OpenSubtitles…' : configured ? 'Save changes' : 'Connect'}
            </button>
          </div>
        </form>
      </Group>
      <Group title="Getting an API key">
        <Row title="1. Create a free account" desc="Sign up at opensubtitles.com (OpenSubtitles.org’s subtitle library now runs on opensubtitles.com)." />
        <Row title="2. Create an API consumer" desc="On opensubtitles.com, open your profile menu → API consumers → New consumer, then paste its API key above." />
        <Row
          title="3. Add your account (recommended)"
          desc="With your OpenSubtitles username and password, downloads use your account’s daily allowance, and still work if your consumer doesn’t allow anonymous downloads. Everyone on this server shares it; subtitles already downloaded are kept on the server, so watching again doesn’t count."
        />
        <Row title="Privacy" desc="The key and password are stored encrypted on this server and are never sent to viewers’ devices. Searches send OpenSubtitles the title, season and episode, not who is watching." />
      </Group>
    </>
  );
}

/* ---------------- Appearance ---------------- */

function AppearanceSection() {
  const a = useUi((s) => s.appearance);
  const set = useUi((s) => s.setAppearance);
  const { prefs, save } = usePrefs();
  const { data: regions } = useQuery({
    queryKey: ['regions'],
    queryFn: async () => {
      const [m, s] = await Promise.all([api.get<Array<{ region?: string }>>('/api/categories?kind=movie'), api.get<Array<{ region?: string }>>('/api/categories?kind=series')]);
      return Array.from(new Set([...m, ...s].map((c) => c.region).filter(Boolean) as string[])).sort();
    },
  });
  return (
    <>
      <Group title="Look">
        <Row title="Appearance">
          <Segmented label="Theme" value={a.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </Row>
        <Row title="Interface size" desc="Scale text and controls for your screen and viewing distance.">
          <Segmented label="Interface size" value={a.scale} onChange={(v) => set({ scale: v })} options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Default' }, { value: 'large', label: 'Large' }]} />
        </Row>
      </Group>
      <Group title="Accessibility">
        <Row title="Reduce motion" desc="Replaces springs, push-ins and the startup animation with simple fades. Follows your system setting by default.">
          <Switch checked={a.motion === 'reduced'} onChange={(v) => set({ motion: v ? 'reduced' : 'system' })} label="Reduce motion" />
        </Row>
        <Row title="Reduce transparency" desc="Makes glass surfaces solid for higher contrast and lower GPU use.">
          <Switch checked={a.transparency === 'reduced'} onChange={(v) => set({ transparency: v ? 'reduced' : 'normal' })} label="Reduce transparency" />
        </Row>
      </Group>
      {regions && regions.length > 0 && (
        <Group title="Regional catalogues on Home">
          <Row title="Show regional titles" desc="Your provider groups some titles by country. Home only shows the regions you choose; Movies and TV Shows always show everything." />
          <div className="chip-rail wrap" style={{ padding: '0.25rem 1.25rem 1.25rem' }}>
            {regions.map((r) => {
              const on = prefs.regions?.includes(r) ?? false;
              return (
                <button key={r} className="chip" aria-pressed={on} onClick={() => save({ regions: on ? (prefs.regions ?? []).filter((x) => x !== r) : [...(prefs.regions ?? []), r] })}>
                  {r}
                </button>
              );
            })}
          </div>
        </Group>
      )}
    </>
  );
}

/* ---------------- Content sources ---------------- */

interface SyncRun {
  id: number;
  provider_id: string;
  started_at: number;
  finished_at?: number;
  ok?: number;
  trigger: string;
  summary?: SyncSummary;
  error?: string;
}

function SourcesSection({ run }: { run: Run }) {
  const qc = useQueryClient();
  const { data: status } = useStatus();
  const { data: syncInfo } = useQuery({
    queryKey: ['sync-status'],
    queryFn: ({ signal }) => api.get<{ runs: SyncRun[]; next: Record<string, number | null> }>('/api/sync/status', signal),
    refetchInterval: status?.sync?.running ? 2000 : 30_000,
  });
  const [adding, setAdding] = useState(false);
  const providers = status?.providers ?? [];

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['status'] });
    void qc.invalidateQueries({ queryKey: ['sync-status'] });
  };

  return (
    <>
      {providers.map((p) => (
        <ProviderCard key={p.id} p={p} running={status?.sync?.running?.providerId === p.id ? status.sync.running : null} next={syncInfo?.next?.[p.id]} run={run} onChange={refresh} />
      ))}
      {!providers.length && <Group><Row title="No content sources" desc="Add an M3U playlist or an Xtream Codes account to start." /></Group>}
      <div style={{ display: 'flex', gap: '0.75rem', margin: '0.5rem 0 1.75rem' }}>
        <button className="glass-btn primary" onClick={() => setAdding(true)}>
          Add source
        </button>
      </div>
      {syncInfo?.runs?.length ? (
        <Group title="Recent refreshes">
          {syncInfo.runs.slice(0, 6).map((r) => (
            <Row
              key={r.id}
              title={`${new Date(r.started_at).toLocaleString()} · ${r.trigger}`}
              desc={
                r.finished_at === undefined || r.finished_at === null
                  ? 'In progress…'
                  : r.ok
                    ? `${r.summary?.channels.toLocaleString()} channels · ${r.summary?.movies.toLocaleString()} movies · ${r.summary?.series.toLocaleString()} series · +${(r.summary?.added.movies ?? 0) + (r.summary?.added.series ?? 0) + (r.summary?.added.channels ?? 0)} new, −${(r.summary?.removed.movies ?? 0) + (r.summary?.removed.series ?? 0) + (r.summary?.removed.channels ?? 0)} removed${r.summary?.renamedChannels ? `, ${r.summary.renamedChannels} renamed` : ''} · ${Math.round((r.summary?.durationMs ?? 0) / 1000)}s${r.summary?.epgError ? ` · guide: ${r.summary.epgError}` : ''}`
                    : `Failed: ${r.error}`
              }
            >
              <span className={`status-dot ${r.ok ? 'ok' : r.finished_at ? 'bad' : 'busy'}`} />
            </Row>
          ))}
        </Group>
      ) : null}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add content source" wide>
        <ProviderForm
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      </Dialog>
    </>
  );
}

function ProviderCard({ p, running, next, run, onChange }: { p: Provider; running: { stage: string; detail?: string } | null; next?: number | null; run: Run; onChange: () => void }) {
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const r = await run(fn);
      if (r !== undefined && ok) toast(ok, { tone: 'success' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong', { tone: 'error' });
    }
    onChange();
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; message: string; latencyMs?: number }>(`/api/providers/${p.id}/test`);
      toast(r.ok ? `${r.message}${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}` : r.message, { tone: r.ok ? 'success' : 'error' });
    } finally {
      setTesting(false);
      onChange();
    }
  };
  const acct = p.account;
  const health = p.needsHttpConsent ? 'Waiting for your permission' : running ? `Refreshing · ${running.detail ?? running.stage}` : p.consecutiveFailures ? `Last refresh failed: ${p.lastError}` : p.lastSuccessAt ? 'Healthy' : 'Not synced yet';
  return (
    <Group title={p.name}>
      <Row title={`${p.type === 'xtream' ? 'Xtream Codes' : 'M3U playlist'} · ${p.host}`} desc={health}>
        <span className={`status-dot ${p.needsHttpConsent ? 'busy' : running ? 'busy' : p.consecutiveFailures ? 'bad' : 'ok'}`} />
      </Row>
      {!p.secure && (
        <Row title="Unencrypted connection (HTTP)" desc="This provider doesn’t support HTTPS. Credentials and viewing activity are visible on the network path to the provider.">
          <Switch checked={!p.needsHttpConsent} onChange={(v) => act(() => api.patch(`/api/providers/${p.id}`, { allowHttp: v }), v ? 'HTTP allowed. Importing…' : 'HTTP disabled')} label="Allow HTTP" />
        </Row>
      )}
      {acct && (
        <Row
          title="Account"
          desc={[
            acct.status,
            acct.expiresAt ? `expires ${new Date(acct.expiresAt).toLocaleDateString()}` : undefined,
            acct.maxConnections ? `${acct.maxConnections} simultaneous streams` : undefined,
            acct.isTrial ? 'trial' : undefined,
            acct.outputFormats.length ? `formats: ${acct.outputFormats.join(', ')}` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      )}
      <Row
        title="Automatic refresh"
        desc={
          p.autoSync
            ? `Every 24 hours while the server runs${next ? ` · next around ${new Date(next).toLocaleString()}` : ''}${p.lastSuccessAt ? ` · last ${new Date(p.lastSuccessAt).toLocaleString()}` : ''}`
            : 'Off — refresh manually.'
        }
      >
        <Switch checked={p.autoSync} onChange={(v) => act(() => api.patch(`/api/providers/${p.id}`, { autoSync: v }))} label="Automatic refresh" />
      </Row>
      <Row title="Enabled" desc="Disabled sources keep their catalogue but can’t play or refresh.">
        <Switch checked={p.enabled} onChange={(v) => act(() => api.patch(`/api/providers/${p.id}`, { enabled: v }))} label="Enabled" />
      </Row>
      <div className="sr-actions">
        <button className="glass-btn sm" onClick={test} disabled={testing || p.needsHttpConsent}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button className="glass-btn sm" onClick={() => act(() => api.post(`/api/providers/${p.id}/sync`), 'Refresh started')} disabled={!!running || p.needsHttpConsent}>
          <IconRefresh /> Refresh now
        </button>
        <button className="glass-btn sm danger" onClick={() => setConfirmRemove(true)}>
          <IconTrash /> Remove
        </button>
      </div>
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${p.name}?`}
        actions={
          <>
            <button className="glass-btn" onClick={() => setConfirmRemove(false)} data-autofocus>
              Cancel
            </button>
            <button
              className="glass-btn danger"
              onClick={() => {
                setConfirmRemove(false);
                void act(() => api.del(`/api/providers/${p.id}`), 'Source removed');
              }}
            >
              Remove
            </button>
          </>
        }
      >
        <p className="t-body">Its channels, movies, series and guide data will be removed from ATLAS. Favourites and progress are kept and reattach if you add the same source again.</p>
      </Dialog>
    </Group>
  );
}

/* ---------------- Storage ---------------- */

function StorageSection({ run }: { run: Run }) {
  const { data, refetch } = useQuery({ queryKey: ['settings-storage'], queryFn: ({ signal }) => api.get<{ images: { files: number; bytes: number }; epg: { n: number; first?: number; last?: number } }>('/api/settings', signal) });
  const { profile } = usePrefs();
  const qc = useQueryClient();
  const clear = async (which: string, label: string) => {
    try {
      const r = await run(() => api.post(`/api/settings/cache/${which}`));
      if (r !== undefined) toast(`${label} cleared`, { tone: 'success' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t clear', { tone: 'error' });
    }
    void refetch();
  };
  const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
  return (
    <>
      <Group title="Server caches">
        <Row title="Artwork cache" desc={data ? `${data.images.files.toLocaleString()} images · ${mb(data.images.bytes)}` : '…'}>
          <button className="glass-btn sm" onClick={() => clear('images', 'Artwork cache')}>
            Clear
          </button>
        </Row>
        <Row
          title="Programme guide"
          desc={data?.epg?.n ? `${data.epg.n.toLocaleString()} listings · ${new Date(data.epg.first!).toLocaleDateString()} – ${new Date(data.epg.last!).toLocaleDateString()}` : 'Empty — refreshed with your sources'}
        >
          <button className="glass-btn sm" onClick={() => clear('epg', 'Guide')}>
            Clear
          </button>
        </Row>
        <Row title="Title details" desc="Plots, cast and artwork fetched from your provider on demand.">
          <button className="glass-btn sm" onClick={() => clear('metadata', 'Title details')}>
            Clear
          </button>
        </Row>
      </Group>
      <Group title="This profile">
        <Row title="Reset recommendations" desc="Recommendations start fresh from your next viewing. History is kept.">
          <button
            className="glass-btn sm"
            onClick={async () => {
              await api.post('/api/me/recommendations/reset');
              void qc.invalidateQueries({ queryKey: ['home'] });
              toast('Recommendations reset', { tone: 'success' });
            }}
          >
            Reset
          </button>
        </Row>
        <Row title="Clear watch history" desc={`Removes ${profile?.name ?? 'this profile'}’s Continue Watching and history.`}>
          <button
            className="glass-btn sm danger"
            onClick={async () => {
              await api.post('/api/me/history/clear');
              void qc.invalidateQueries({ queryKey: ['home'] });
              toast('Watch history cleared', { tone: 'success' });
            }}
          >
            Clear
          </button>
        </Row>
      </Group>
    </>
  );
}

/* ---------------- About ---------------- */

function AboutSection() {
  const { data } = useQuery({ queryKey: ['diagnostics'], queryFn: ({ signal }) => api.get<any>('/api/diagnostics', signal) });
  const device = useUi((s) => s.device);
  const video = document.createElement('video');
  const caps = [
    ['HLS (native)', video.canPlayType('application/vnd.apple.mpegurl') ? 'yes' : 'via hls.js'],
    ['Media Source Extensions', 'MediaSource' in window ? 'yes' : 'no'],
    ['H.264', video.canPlayType('video/mp4; codecs="avc1.640028"') || 'no'],
    ['HEVC / H.265', video.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') || 'no'],
    ['AV1', video.canPlayType('video/mp4; codecs="av01.0.08M.08"') || 'no'],
    ['Picture-in-Picture', 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled ? 'yes' : 'no'],
    ['HDR display', matchMedia('(dynamic-range: high)').matches ? 'yes' : 'no'],
  ];
  return (
    <>
      <Group title="ATLAS">
        <Row title="Version" desc={`Web ${__APP_VERSION__} · server ${data?.version ?? '…'} · ${device} layout${atlasNative() ? ' · Android app' : ''}`} />
        {atlasNative() && (
          <Row title="Server" desc={`This app is connected to ${location.origin}`}>
            <button className="glass-btn sm" onClick={() => atlasNative()!.changeServer()}>
              Change server
            </button>
          </Row>
        )}
        <Row title="Build" desc={`${import.meta.env.MODE} · ${__BUILD_TIME__}`} />
      </Group>
      <Group title="Diagnostics">
        {data && (
          <>
            <Row title="Catalogue" desc={`${data.catalog.channels.toLocaleString()} channels · ${data.catalog.movies.toLocaleString()} movies · ${data.catalog.series.toLocaleString()} series · ${data.catalog.programmes.toLocaleString()} guide listings`} />
            <Row title="Search index" desc={`${data.searchIndex.documents.toLocaleString()} documents`} />
            <Row title="Server" desc={`Node ${data.node} · up ${Math.round(data.uptimeSec / 60)} min · ${data.memoryMb.rss} MB memory`} />
          </>
        )}
        <Row title="This device can play" desc={caps.map(([k, v]) => `${k}: ${v}`).join(' · ')} />
      </Group>
      <Group title="Privacy">
        <Row
          title="Your data stays on your server"
          desc="Profiles, watch history and provider credentials are stored on the ATLAS server you run. Provider passwords are encrypted at rest, never sent to this browser, and redacted from logs. Artwork is loaded from the addresses your provider supplies."
        />
      </Group>
      <Group title="Open-source licences">
        <Row title="React, React Router, TanStack Query & Virtual, Zustand, Framer Motion" desc="MIT License" />
        <Row title="hls.js" desc="Apache License 2.0" />
        <Row title="mpegts.js" desc="Apache License 2.0" />
        <Row title="Fastify, Vite, tsx" desc="MIT License" />
        <Row title="Inter typeface" desc="SIL Open Font License 1.1" />
      </Group>
    </>
  );
}
