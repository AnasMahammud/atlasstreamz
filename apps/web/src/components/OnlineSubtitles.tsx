import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, enc, type SubtitleResult, type SubtitleSearch } from '../lib/api.ts';
import { focusFirst } from '../lib/focus.ts';
import { toast } from '../lib/store.ts';
import { IconChevronLeft } from './Icons.tsx';

/** Languages offered as one-press choices; the profile's own language is added if missing. */
const LANGUAGES: Array<[string, string]> = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['pl', 'Polish'],
];

/** "en" → "English", "pt-br" → "Portuguese (Brazil)"; falls back to the code on older browsers. */
export function languageName(code: string): string {
  const known = LANGUAGES.find(([c]) => c === code)?.[1];
  if (known) return known;
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * OpenSubtitles search inside the player's subtitles menu. Results matched by the title's TMDB
 * ID come first; when only a name match was possible, each result says what it was made for so
 * the viewer can check it before choosing.
 */
export function OnlineSubtitles({ contentId, defaultLang, onBack, onPick }: { contentId: string; defaultLang?: string; onBack: () => void; onPick: (r: SubtitleResult) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lang, setLang] = useState(defaultLang || 'en');
  const [busy, setBusy] = useState<number | null>(null);
  const languages: Array<[string, string]> = [...(LANGUAGES.some(([c]) => c === lang) || lang === 'all' ? [] : [[lang, languageName(lang)] as [string, string]]), ...LANGUAGES, ['all', 'All']];
  const search = useQuery({
    queryKey: ['subtitle-search', contentId, lang],
    queryFn: ({ signal }) => api.get<SubtitleSearch>(`/api/subtitles/search?id=${enc(contentId)}&lang=${enc(lang)}`, signal),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const results = search.data?.results ?? [];

  useEffect(() => focusFirst(ref.current ?? document), []);

  const pick = async (r: SubtitleResult) => {
    setBusy(r.fileId);
    try {
      await onPick(r);
    } catch (err) {
      toast(err instanceof ApiError || err instanceof Error ? err.message : 'Couldn’t load those subtitles.', { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="menu-section online-subs" ref={ref}>
      <button className="menu-item" onClick={onBack} data-autofocus>
        <IconChevronLeft /> Subtitles
      </button>
      <div className="t-eyebrow" style={{ padding: '0.4rem 0.9rem' }}>
        Find subtitles online
      </div>
      <div className="menu-inline">
        {languages.map(([code, label]) => (
          <button key={code} className="chip" aria-pressed={lang === code} onClick={() => setLang(code)}>
            {label}
          </button>
        ))}
      </div>
      {search.isLoading && <p className="t-caption menu-meta">Searching OpenSubtitles…</p>}
      {search.error && <p className="t-caption menu-meta error">{search.error instanceof Error ? search.error.message : 'Couldn’t search OpenSubtitles.'}</p>}
      {search.data && !results.length && (
        <p className="t-caption menu-meta">No {lang === 'all' ? '' : `${languageName(lang)} `}subtitles found for this title. Try another language.</p>
      )}
      {search.data?.match === 'title' && results.length > 0 && <p className="t-caption menu-meta">Found by name only. Check the title shown under each result.</p>}
      {results.map((r) => (
        <button key={r.fileId} className="menu-item sub-result" onClick={() => pick(r)} disabled={busy !== null} aria-busy={busy === r.fileId}>
          <span className="sub-lang">{r.language.toUpperCase()}</span>
          <span className="sub-text">
            <span className="sub-release">{r.release}</span>
            <span className="sub-meta">
              {busy === r.fileId
                ? 'Downloading…'
                : [
                    `${r.downloads.toLocaleString()} downloads`,
                    r.hearingImpaired && 'For deaf and hard of hearing',
                    r.machineTranslated && 'Machine translated',
                    r.match === 'title' && r.feature,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </span>
        </button>
      ))}
      <p className="t-caption menu-meta">Subtitles from OpenSubtitles.com</p>
    </div>
  );
}
