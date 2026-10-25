import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api.ts';
import { Segmented } from '../../components/Primitives.tsx';
import { IconAlert, IconCheck } from '../../components/Icons.tsx';
import { toast } from '../../lib/store.ts';

interface TestResult {
  ok: boolean;
  message: string;
  needsHttpConsent?: boolean;
  account?: { status?: string; expiresAt?: number; maxConnections?: number };
  latencyMs?: number;
}

/** Add an M3U playlist or Xtream account: test first, ask before using plain HTTP, then import. */
export function ProviderForm({ onSaved }: { onSaved: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'m3u' | 'xtream'>('m3u');
  const [name, setName] = useState('');
  const [m3uUrl, setM3uUrl] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [epgUrl, setEpgUrl] = useState('');
  const [allowHttp, setAllowHttp] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = () => (mode === 'm3u' ? { name, m3uUrl, epgUrl: epgUrl || undefined, allowHttp } : { name, serverUrl, username, password, epgUrl: epgUrl || undefined, allowHttp });

  const runTest = async () => {
    setBusy(true);
    setError(null);
    try {
      setTest(await api.post<TestResult>('/api/providers/test', payload()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Test failed.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!test?.ok) return runTest();
    setBusy(true);
    try {
      await api.post('/api/providers', payload());
      toast('Source added. Importing your catalogue…', { tone: 'success' });
      void qc.invalidateQueries({ queryKey: ['status'] });
      void qc.invalidateQueries({ queryKey: ['providers'] });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add the source.');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => setTest(null);

  return (
    <form onSubmit={save} style={{ display: 'grid', gap: '1rem' }}>
      <Segmented
        label="Source type"
        value={mode}
        onChange={(v) => {
          setMode(v);
          reset();
        }}
        options={[
          { value: 'm3u', label: 'M3U playlist' },
          { value: 'xtream', label: 'Xtream Codes' },
        ]}
      />
      <div className="field">
        <label htmlFor="pv-name">Name</label>
        <input id="pv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" />
      </div>
      {mode === 'm3u' ? (
        <div className="field">
          <label htmlFor="pv-url">Playlist URL</label>
          <input id="pv-url" className="input" type="url" value={m3uUrl} onChange={(e) => (setM3uUrl(e.target.value), reset())} placeholder="https://…/playlist.m3u8" autoComplete="off" spellCheck={false} />
          <span className="hint">Links from Xtream panels (get.php) are detected and use the richer Xtream API automatically.</span>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="pv-server">Server URL</label>
            <input id="pv-server" className="input" value={serverUrl} onChange={(e) => (setServerUrl(e.target.value), reset())} placeholder="http://provider.example:8080" autoComplete="off" spellCheck={false} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div className="field">
              <label htmlFor="pv-user">Username</label>
              <input id="pv-user" className="input" value={username} onChange={(e) => (setUsername(e.target.value), reset())} autoComplete="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="pv-pass">Password</label>
              <input id="pv-pass" className="input" type="password" value={password} onChange={(e) => (setPassword(e.target.value), reset())} autoComplete="off" />
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="pv-epg">EPG / XMLTV URL (optional)</label>
        <input id="pv-epg" className="input" value={epgUrl} onChange={(e) => setEpgUrl(e.target.value)} placeholder="Uses the provider’s guide when empty" autoComplete="off" spellCheck={false} />
      </div>

      {test?.needsHttpConsent && (
        <div className="notice warn">
          <IconAlert />
          <div>
            <strong>Unencrypted connection.</strong> {test.message} ATLAS stores the credentials encrypted on this server, but can’t protect the connection to the provider.
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.6rem' }}>
              <input
                type="checkbox"
                checked={allowHttp}
                onChange={(e) => {
                  setAllowHttp(e.target.checked);
                  setTest(null);
                }}
              />
              I understand — allow HTTP for this provider
            </label>
          </div>
        </div>
      )}
      {test && !test.needsHttpConsent && (
        <div className={`notice ${test.ok ? 'ok' : 'warn'}`}>
          {test.ok ? <IconCheck /> : <IconAlert />}
          <div>
            <strong>{test.message}</strong>
            {test.account?.expiresAt && <> Account expires {new Date(test.account.expiresAt).toLocaleDateString()}.</>}
            {test.account?.maxConnections && <> Up to {test.account.maxConnections} simultaneous streams.</>}
          </div>
        </div>
      )}
      {error && <span className="error" style={{ color: 'var(--danger)' }}>{error}</span>}
      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="glass-btn" onClick={runTest} disabled={busy}>
          Test connection
        </button>
        <button type="submit" className="glass-btn primary" disabled={busy || (!test?.ok && !!test)}>
          {test?.ok ? 'Add and import' : 'Check and add'}
        </button>
      </div>
    </form>
  );
}
