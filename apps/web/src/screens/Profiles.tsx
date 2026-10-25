import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { isValidPin } from '@atlas/core';
import { api, ApiError, type Profile } from '../lib/api.ts';
import { useProfiles, useStatus } from '../lib/queries.ts';
import { Avatar, AtlasEmblem, avatarColor } from '../components/Brand.tsx';
import { Dialog, Switch } from '../components/Primitives.tsx';
import { PinPad } from '../components/PinPad.tsx';
import { IconEdit, IconLock, IconPlus } from '../components/Icons.tsx';
import { focusFirst } from '../lib/focus.ts';
import { toast } from '../lib/store.ts';

/** "Who's watching?" — premium glass profile cards with a responsive ambient glow. */
export function Profiles() {
  const { data, isLoading } = useProfiles();
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [focusColor, setFocusColor] = useState<string>('#81C7FF');
  const [pinFor, setPinFor] = useState<Profile | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [manage, setManage] = useState(false);
  const profiles = data?.profiles ?? [];

  useEffect(() => {
    if (!isLoading) focusFirst();
  }, [isLoading, manage]);

  // Leaving a profile clears the server-side selection so the next person starts fresh.
  useEffect(() => {
    if (status?.profile) void api.post('/api/profiles/deselect').then(() => qc.invalidateQueries({ queryKey: ['status'] }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enter = useCallback(
    async (p: Profile, pin?: string) => {
      setBusy(true);
      try {
        await api.post(`/api/profiles/${p.id}/select`, pin ? { pin } : {});
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'profiles' });
        await qc.invalidateQueries({ queryKey: ['status'] });
        setPinFor(null);
        navigate('/', { replace: true });
      } catch (err) {
        if (err instanceof ApiError) {
          const lockedMin = err.data.lockedForMs ? Math.ceil(err.data.lockedForMs / 60_000) : 0;
          setPinError(err.data.reason === 'locked' ? `Locked. Try again in ${lockedMin} min.` : err.data.remaining !== undefined ? `Wrong PIN · ${err.data.remaining} tries left` : err.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [navigate, qc],
  );

  const choose = (p: Profile) => {
    if (manage) return setEditing(p);
    if (p.hasPin) {
      setPinError(null);
      setPinFor(p);
    } else void enter(p);
  };

  return (
    <div className="profiles" style={{ ['--glow' as string]: focusColor }}>
      <div className="profiles-glow" />
      <header className="profiles-head">
        <AtlasEmblem size={44} />
      </header>
      <motion.h1 className="t-headline" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 26 }}>
        {manage ? 'Manage Profiles' : profiles.length || isLoading ? 'Who’s watching?' : 'Create your first profile'}
      </motion.h1>
      <div className="profile-grid" data-focus-zone="profiles">
        {profiles.map((p, i) => (
          <motion.button
            key={p.id}
            className="profile-card"
            initial={{ opacity: 0, y: 26, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 240, damping: 24, delay: 0.06 * i }}
            onFocus={() => setFocusColor(avatarColor(p.avatar))}
            onMouseEnter={() => setFocusColor(avatarColor(p.avatar))}
            onClick={() => choose(p)}
            aria-label={`${p.name}${p.hasPin ? ', PIN protected' : ''}${manage ? ', edit' : ''}`}
            data-autofocus={i === 0 ? true : undefined}
          >
            <span className="profile-orb glass">
              <Avatar avatar={p.avatar} name={p.name} size={140} />
              {manage && (
                <span className="profile-edit">
                  <IconEdit />
                </span>
              )}
            </span>
            <span className="profile-name">
              {p.name}
              {p.hasPin && <IconLock className="lock" />}
            </span>
            {p.isKids && <span className="badge">Kids</span>}
          </motion.button>
        ))}
        {profiles.length < 8 && (
          <motion.button
            className="profile-card add"
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 240, damping: 24, delay: 0.06 * profiles.length }}
            onClick={() => setEditing('new')}
            onFocus={() => setFocusColor('#81C7FF')}
            data-autofocus={profiles.length === 0 ? true : undefined}
          >
            <span className="profile-orb glass">
              <IconPlus style={{ width: '2.6rem', height: '2.6rem' }} />
            </span>
            <span className="profile-name">Add Profile</span>
          </motion.button>
        )}
      </div>
      {profiles.length > 0 && (
        <button className="glass-btn" onClick={() => setManage((m) => !m)}>
          {manage ? 'Done' : 'Manage Profiles'}
        </button>
      )}

      <Dialog open={!!pinFor} onClose={() => setPinFor(null)}>
        {pinFor && (
          <div style={{ display: 'grid', justifyItems: 'center', gap: '1rem' }}>
            <Avatar avatar={pinFor.avatar} name={pinFor.name} size={72} />
            <h2 style={{ margin: 0 }}>{pinFor.name}</h2>
            <PinPad allowVariable onSubmit={(pin) => enter(pinFor, pin)} error={pinError} busy={busy} label="Enter your profile PIN" />
            <p className="t-caption" style={{ textAlign: 'center', maxWidth: '22rem' }}>
              Forgot it? Reset this PIN under Manage Profiles with your account password.
            </p>
          </div>
        )}
      </Dialog>

      <ProfileEditor
        target={editing}
        avatars={data?.avatars ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: ['profiles'] });
        }}
      />
    </div>
  );
}

function ProfileEditor({ target, avatars, onClose, onSaved }: { target: Profile | 'new' | null; avatars: string[]; onClose: () => void; onSaved: () => void }) {
  const isNew = target === 'new';
  const p = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('aurora');
  const [kids, setKids] = useState(false);
  const [pin, setPin] = useState('');
  const [removePin, setRemovePin] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(p?.name ?? '');
    setAvatar(p?.avatar ?? avatars[Math.floor(Math.random() * Math.max(1, avatars.length))] ?? 'aurora');
    setKids(p?.isKids ?? false);
    setPin('');
    setRemovePin(false);
    setCurrentPin('');
    setOwnerPw('');
    setError(null);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const creds = () => (ownerPw ? { password: ownerPw } : currentPin ? { pin: currentPin } : {});

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Enter a name.');
    if (pin && !isValidPin(pin)) return setError('PINs are 4 to 6 digits.');
    setBusy(true);
    try {
      if (isNew) {
        await api.post('/api/profiles', { name, avatar, isKids: kids, pin: pin || undefined });
      } else if (p) {
        await api.patch(`/api/profiles/${p.id}`, { name, avatar, isKids: kids, ...creds() });
        if (pin || removePin) await api.post(`/api/profiles/${p.id}/pin`, { newPin: removePin ? null : pin, currentPin: currentPin || undefined, password: ownerPw || undefined });
      }
      toast(isNew ? `Welcome, ${name.trim()}` : 'Profile saved', { tone: 'success' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the profile.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!p) return;
    setBusy(true);
    try {
      await api.del(`/api/profiles/${p.id}`, creds());
      toast(`Removed ${p.name}`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t remove the profile.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onClose={onClose} title={isNew ? 'Add Profile' : `Edit ${p?.name ?? ''}`} wide>
      <form onSubmit={save} style={{ display: 'grid', gap: '1.25rem', marginTop: '1rem' }}>
        <div className="avatar-picker" role="radiogroup" aria-label="Avatar">
          {avatars.map((a) => (
            <button type="button" key={a} role="radio" aria-checked={avatar === a} className="avatar-choice" onClick={() => setAvatar(a)} aria-label={a}>
              <Avatar avatar={a} name={name || '?'} size={64} />
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="pname">Name</label>
          <input id="pname" className="input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} data-autofocus />
        </div>
        <div className="settings-row" style={{ padding: 0 }}>
          <div>
            <div className="t-title">Kids profile</div>
            <div className="t-caption">Only Kids &amp; Animation categories. Turning this off needs the account password.</div>
          </div>
          <Switch checked={kids} onChange={setKids} label="Kids profile" />
        </div>
        <div className="field">
          <label htmlFor="ppin">{p?.hasPin ? 'New PIN (optional)' : 'PIN (optional, 4–6 digits)'}</label>
          <input
            id="ppin"
            className="input"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            disabled={removePin}
            placeholder="••••"
          />
          {p?.hasPin && (
            <label className="t-caption" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.3rem' }}>
              <input type="checkbox" checked={removePin} onChange={(e) => setRemovePin(e.target.checked)} /> Remove the PIN
            </label>
          )}
        </div>
        {p?.hasPin && (
          <div className="auth-box glass">
            <div className="t-caption">This profile is protected. Confirm with its current PIN, or your account password if it was forgotten.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <input className="input" inputMode="numeric" maxLength={6} placeholder="Current PIN" value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))} aria-label="Current PIN" />
              <input className="input" type="password" placeholder="Account password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} aria-label="Account password" autoComplete="current-password" />
            </div>
          </div>
        )}
        {p?.isKids && !kids && !p.hasPin && (
          <input className="input" type="password" placeholder="Account password (required to leave Kids mode)" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} aria-label="Account password" />
        )}
        {error && <div className="field"><span className="error">{error}</span></div>}
        <div className="actions" style={{ justifyContent: 'space-between' }}>
          {p ? (
            <button type="button" className="glass-btn danger" onClick={remove} disabled={busy}>
              Delete profile
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button type="button" className="glass-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="glass-btn primary" disabled={busy}>
              {isNew ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

export function AnimatedSwap({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div key={k} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
