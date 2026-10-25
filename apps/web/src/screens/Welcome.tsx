import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Provider } from '../lib/api.ts';
import { useStatus } from '../lib/queries.ts';
import { AtlasEmblem } from '../components/Brand.tsx';
import { focusFirst } from '../lib/focus.ts';
import { IconAlert, IconCheck, IconLock } from '../components/Icons.tsx';
import { ProviderForm } from './settings/ProviderForm.tsx';

const stageLabel: Record<string, string> = {
  starting: 'Connecting',
  account: 'Checking your account',
  categories: 'Reading categories',
  live: 'Importing live channels',
  movies: 'Importing movies',
  series: 'Importing series',
  playlist: 'Downloading playlist',
  parsing: 'Reading playlist',
  saving: 'Saving your catalogue',
  epg: 'Downloading the programme guide',
};

/** First run: owner account → provider (consent for HTTP) → first sync → profiles. */
export function Setup() {
  const { data: status, refetch } = useStatus();
  const navigate = useNavigate();
  const [step, setStep] = useState<'password' | 'source'>('password');

  useEffect(() => {
    if (status && !status.setupRequired && status.signedIn) setStep('source');
  }, [status]);

  return (
    <div className="welcome">
      <div className="welcome-card glass">
        <AnimatePresence mode="wait">
          {step === 'password' ? (
            <motion.div key="pw" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <OwnerPassword
                needsCode={!!status?.setupCodeRequired}
                onDone={async () => {
                  await refetch();
                  setStep('source');
                }}
              />
            </motion.div>
          ) : (
            <motion.div key="src" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <SourceStep onDone={() => navigate('/profiles', { replace: true })} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function OwnerPassword({ onDone, needsCode }: { onDone: () => void; needsCode: boolean }) {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => focusFirst(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (needsCode && !code.trim()) return setError('Enter the setup code from your hosting dashboard.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (pw.length < 8) return setError('Use at least 8 characters.');
    if (pw !== pw2) return setError('The passwords don’t match.');
    setBusy(true);
    try {
      await api.post('/api/setup', { email: email.trim(), password: pw, setupCode: needsCode ? code : undefined });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="welcome-form">
      <AtlasEmblem size={64} />
      <div>
        <h1 className="t-headline">Welcome to ATLAS</h1>
        <p className="t-body" style={{ marginTop: '0.6rem' }}>
          Create the owner account for this server. You control who else can sign up, and every person who joins gets their own profiles, history and content sources.
        </p>
      </div>
      {needsCode && (
        <div className="field">
          <label htmlFor="setup-code">Setup code</label>
          <input id="setup-code" className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus />
          <span className="hint">This server is on the internet. Copy ATLAS_SETUP_TOKEN from your Render dashboard (Environment) so only you can claim it.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="owner-email">Email</label>
        <input id="owner-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus={needsCode ? undefined : true} />
      </div>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw2">Confirm password</label>
        <input id="pw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {error && <span className="error">{error}</span>}
      </div>
      <button className="glass-btn primary lg" type="submit" disabled={busy}>
        <IconLock /> Create owner account
      </button>
    </form>
  );
}

function SourceStep({ onDone }: { onDone: () => void }) {
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const providers = status?.providers ?? [];
  const pending = providers.find((p) => p.needsHttpConsent);
  const running = status?.sync?.running;
  const synced = providers.some((p) => p.lastSuccessAt);
  const failed = providers.find((p) => p.lastError && !p.lastSuccessAt && !running);
  const [adding, setAdding] = useState(false);

  useEffect(() => focusFirst(), [pending?.id, synced, !!running, adding]);

  const allow = async (p: Provider) => {
    await api.patch(`/api/providers/${p.id}`, { allowHttp: true });
    void qc.invalidateQueries({ queryKey: ['status'] });
  };

  if (pending) {
    return (
      <div className="welcome-form">
        <div className="consent-icon">
          <IconAlert />
        </div>
        <div>
          <span className="t-eyebrow">Content source</span>
          <h1 className="t-headline" style={{ marginTop: '0.4rem' }}>
            {pending.name}
          </h1>
          <p className="t-body" style={{ marginTop: '0.75rem' }}>
            ATLAS found the provider configured on this server (<strong>{pending.host}</strong>). It only offers an <strong>unencrypted HTTP</strong> connection. That means your provider
            username, password and what you watch can be seen by anyone on the networks between you and the provider.
          </p>
          <p className="t-body" style={{ marginTop: '0.6rem' }}>
            ATLAS keeps the credentials encrypted on this server and never sends them to your browser, but it can’t encrypt the provider’s own connection.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button className="glass-btn primary lg" onClick={() => allow(pending)} data-autofocus>
            Allow HTTP for this provider
          </button>
          <button className="glass-btn lg" onClick={onDone}>
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (running || (!synced && providers.length && !failed)) {
    const stage = running?.stage ?? 'starting';
    return (
      <div className="welcome-form" aria-live="polite">
        <AtlasEmblem size={64} />
        <div>
          <h1 className="t-headline">Building your universe</h1>
          <p className="t-body" style={{ marginTop: '0.6rem' }}>
            {stageLabel[stage] ?? 'Working'}… {running?.detail && running.detail !== stageLabel[stage] ? running.detail : ''}
          </p>
        </div>
        <div className="sync-steps">
          {['account', 'live', 'movies', 'series', 'saving', 'epg'].map((s) => {
            const order = ['starting', 'account', 'categories', 'live', 'movies', 'series', 'saving', 'epg'];
            const done = order.indexOf(stage) > order.indexOf(s);
            const active = stage === s || (s === 'account' && stage === 'categories');
            return (
              <div key={s} className={`sync-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                <span className="mark">{done ? <IconCheck /> : active ? <span className="spinner" style={{ width: '1rem', height: '1rem', borderWidth: 2 }} /> : null}</span>
                {stageLabel[s]}
              </div>
            );
          })}
        </div>
        <p className="t-caption">This runs on the server. You can continue and ATLAS will fill in as it finishes.</p>
        <button className="glass-btn" onClick={onDone}>
          Continue
        </button>
      </div>
    );
  }

  if (synced) {
    const c = status?.catalog;
    return (
      <div className="welcome-form">
        <div className="consent-icon ok">
          <IconCheck />
        </div>
        <div>
          <h1 className="t-headline">You’re all set</h1>
          {c && (
            <p className="t-body" style={{ marginTop: '0.6rem' }}>
              {c.channels.toLocaleString()} live channels, {c.movies.toLocaleString()} movies and {c.series.toLocaleString()} series are ready
              {c.programmes ? `, with ${c.programmes.toLocaleString()} guide listings` : ''}.
            </p>
          )}
        </div>
        <button className="glass-btn primary lg" onClick={onDone} data-autofocus>
          Choose a profile
        </button>
      </div>
    );
  }

  return (
    <div className="welcome-form">
      <div>
        <h1 className="t-headline">Add a content source</h1>
        <p className="t-body" style={{ marginTop: '0.6rem' }}>
          {failed ? `The last attempt failed: ${failed.lastError}` : 'Connect an M3U playlist or an Xtream Codes account. Credentials stay encrypted on this server.'}
        </p>
      </div>
      {adding || !providers.length ? (
        <ProviderForm onSaved={() => setAdding(false)} />
      ) : (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {failed && (
            <button className="glass-btn primary" onClick={() => api.post(`/api/providers/${failed.id}/sync`).then(() => qc.invalidateQueries({ queryKey: ['status'] }))} data-autofocus>
              Try again
            </button>
          )}
          <button className="glass-btn" onClick={() => setAdding(true)}>
            Add another source
          </button>
          <button className="glass-btn" onClick={onDone}>
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: status } = useStatus();
  useEffect(() => focusFirst(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email: email.trim(), password: pw });
      // Drop cached "signed out" state, otherwise the route guard would bounce us back here.
      qc.removeQueries();
      navigate('/profiles', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };
  const canRegister = status?.registration && status.registration !== 'closed';
  return (
    <div className="welcome">
      <form className="welcome-card glass welcome-form" onSubmit={submit}>
        <AtlasEmblem size={64} />
        <div>
          <h1 className="t-headline">Sign in to ATLAS</h1>
          <p className="t-body" style={{ marginTop: '0.6rem' }}>
            Use the email and password of your ATLAS account.
          </p>
        </div>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" className="input" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />
        </div>
        <div className="field">
          <label htmlFor="login-pw">Password</label>
          <input id="login-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {error && <span className="error">{error}</span>}
        </div>
        <button className="glass-btn primary lg" type="submit" disabled={busy || !email || !pw}>
          Sign in
        </button>
        {canRegister && (
          <p className="t-caption" style={{ textAlign: 'center' }}>
            New here?{' '}
            <Link to="/register" className="link">
              Create an account
            </Link>
          </p>
        )}
      </form>
    </div>
  );
}

/** Sign-up: every person gets their own account, profiles and content sources. */
export function Register() {
  const [params] = useSearchParams();
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(params.get('invite') ?? '');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => focusFirst(), []);
  const mode = status?.registration ?? 'invite';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === 'invite' && !invite.trim()) return setError('Enter the invite code you were sent.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (pw.length < 8) return setError('Use at least 8 characters.');
    if (pw !== pw2) return setError('The passwords don’t match.');
    setBusy(true);
    try {
      await api.post('/api/auth/register', { email: email.trim(), password: pw, inviteCode: invite.trim() || undefined });
      qc.removeQueries();
      navigate('/profiles', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t create the account.');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'closed') {
    return (
      <div className="welcome">
        <div className="welcome-card glass welcome-form">
          <AtlasEmblem size={64} />
          <h1 className="t-headline">Sign-ups are closed</h1>
          <p className="t-body">This ATLAS server isn’t accepting new accounts right now. Ask its owner for access.</p>
          <Link to="/login" className="glass-btn primary" data-autofocus>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="welcome">
      <form className="welcome-card glass welcome-form" onSubmit={submit}>
        <AtlasEmblem size={64} />
        <div>
          <h1 className="t-headline">Create your account</h1>
          <p className="t-body" style={{ marginTop: '0.6rem' }}>
            You’ll get your own profiles, watch history and recommendations, and you’ll add your own playlist or Xtream account.
          </p>
        </div>
        {mode === 'invite' && (
          <div className="field">
            <label htmlFor="reg-invite">Invite code</label>
            <input id="reg-invite" className="input" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus={invite ? undefined : true} />
          </div>
        )}
        <div className="field">
          <label htmlFor="reg-email">Email</label>
          <input id="reg-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus={mode === 'open' || invite ? true : undefined} />
        </div>
        <div className="field">
          <label htmlFor="reg-pw">Password</label>
          <input id="reg-pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="reg-pw2">Confirm password</label>
          <input id="reg-pw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          {error && <span className="error">{error}</span>}
        </div>
        <button className="glass-btn primary lg" type="submit" disabled={busy}>
          Create account
        </button>
        <p className="t-caption" style={{ textAlign: 'center' }}>
          Already have an account?{' '}
          <Link to="/login" className="link">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
