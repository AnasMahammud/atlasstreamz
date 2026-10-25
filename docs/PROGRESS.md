# ATLAS — progress and handoff

Last updated: 25 October 2026 (accounts and Android app added). "Verified" means exercised in this session against your real provider (9,876 live channels, 16,200 movies, 3,523 series, ~54,500 guide listings) in desktop Chromium, or covered by automated tests. Anything else is marked as unverified.

## New in this round

- **Separate accounts.** Every person signs up with their own email and password and gets their own profiles, PINs, history, My List, recommendations and content sources. Sign-up is invite-only by default; the owner can switch to open or closed and manage accounts under Settings → Members. Verified with automated tests (an invited friend can't see, search, play or stream the owner's content) and in the browser (invite link → new account → "Create your first profile" → "Connect a content source").
- **Android app.** One signed APK (`dist\ATLAS.apk`, 4.1 MB) for phones, Android TV and Fire TV: the ATLAS interface plus a native Media3/ExoPlayer player. Built and statically verified on this PC: the manifest has the phone and TV launchers, the TV banner and only optional hardware features, and the signature verifies (v1+v2). **Not yet run on a real device.** See [ANDROID.md](ANDROID.md).
- **Public-server hardening.** On Render, upstream fetches can't reach private or internal addresses, so members can't use playlist URLs to probe the server's network.

## Phase status

| Phase | Status |
| --- | --- |
| 1 Foundation | **Done.** npm-workspaces monorepo, shared `@atlas/core`, design tokens, SQLite with versioned migrations, encrypted secrets, local env handling. |
| 2 Premium interface | **Done for web.** Startup animation, profiles + PIN pad, Home hero + shelves, Liquid Glass components, top glass nav (desktop/TV) and bottom glass nav (mobile), detail pages, Movies/Shows grids, ambient artwork backgrounds. |
| 3 Provider integration | **Done.** M3U streaming parser, Xtream API (auto-detected from `get.php` links), XMLTV streaming parser, normalisation, 24 h sync with backoff, atomic apply, favourite re-matching. |
| 4 Streaming player | **Done for web.** HLS (hls.js), MPEG-TS (mpegts.js) and native files; live and VOD; resume; audio, subtitle and quality menus; speed; aspect; PiP; fullscreen; up-next countdown. |
| 5 Advanced features | **Mostly done.** EPG timeline, typo-tolerant search, My List, PIN security, multi-profile personalisation, content-based recommendations, stream recovery. *Not done:* online subtitle search (needs a subtitle-service API key). |
| 6 Device optimisation | **Partial.** Responsive mobile and desktop, TV mode with spatial navigation and no live blur, Android APK with native playback. *Not done:* iOS app; testing on real phones, TVs and Fire TV. |
| 7 Production readiness | **Partial.** Security review of auth flows, 53 automated tests, production build, PWA, Render blueprint and deploy script. *Not done:* native release builds, load testing. |

## Acceptance criteria

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Cinematic branded startup | Verified (full ~2.7 s first run, ~1.1 s on return, fade with reduced motion; skippable). |
| 2 | Create a profile and protect it with a PIN | Verified in the UI and tests (scrypt hashing, lockout after 5 failures, owner-password reset). |
| 3 | Connect an M3U or Xtream provider | Verified with your provider (Xtream via `get.php`, HTTP consent flow). M3U-only path covered by tests. |
| 4 | Browse live channels | Verified (category rail, channel wall with now-playing). |
| 5 | Play a compatible stream | Verified: Sky News live (HLS, measured 1024×576 → "SD"), MP4 movie (1920×800 → 1080p), MKV movie (1924×1040) in Chromium. |
| 6 | Real EPG when data exists | Verified (timeline guide; opens on the category with the most listings). |
| 7 | Browse movies and series | Verified (16,200-title virtualised grid, filters, series seasons/episodes fetched on demand). |
| 8 | Open a movie and resume | Verified: progress saved and restored; "Resume" and "From the beginning". |
| 9 | Browse seasons and episodes | Verified. |
| 10 | Choose audio and subtitle tracks | Implemented for HLS renditions and native tracks. Your provider's streams tested so far carry one audio track, so switching is unverified against real multi-track content. |
| 11 | Authorised external subtitles | Local `.srt`/`.vtt` import with styling and sync works. Online lookup is **not implemented**. |
| 12 | Favourites | Verified (My List, favourite channels, kept across syncs). |
| 13 | Search the catalogue | Verified ("acountant" finds The Accountant, ~70 ms server-side). |
| 14 | Manual and automatic refresh | Verified manual refresh (13 s, no churn). The 24 h schedule and backoff are covered by unit tests; a real 24 h cycle has not been observed. |
| 15 | Recover from broken connections | Implemented (retry with backoff, engine fallback, provider diagnosis, offered alternates, auto-retry when back online). Exercised only through the happy path and code review. Deliberate failure injection is still to do. |
| 16 | Navigate entirely with a TV remote | Verified with arrow, Enter and Back keys in Chromium TV mode. **Not verified on Android TV / Fire TV hardware.** |
| 17 | Use on mobile and desktop web | Verified at desktop and phone widths in the browser pane. Not verified on real iOS/Android browsers. |
| 18 | Production build artifacts | Web bundle and **signed Android APK** built. No AAB (Play Store) or iOS IPA. |

## Bugs found and fixed during verification

- Fastify's 100-character route-parameter limit broke HLS segment tokens (414). Raised.
- The channel endpoint overwrote the "next programme" field with the next channel's ID. Renamed to `prevChannel`/`nextChannel`.
- Genre detection missed "Comedy", "Documentary" and "Animation" (word-boundary bug), so those Home rows were missing.
- Quality labels ignored width, so a 1920×800 film was called 720p. Now letterbox-aware.
- After signing in, the route guard read the cached "signed out" status and bounced back to the sign-in page.
- The PIN pad's keyboard Backspace and Enter didn't work; remote OK and keyboard Enter are now told apart.
- A full-page CSS filter on the app wrapper would have broken the fixed nav and player. Removed.
- The guide opened on a category with no listings. It now picks the best-covered category.
- The deploy script's credential scan failed open when `git grep` errored. It now stops on any scan error, and was proven against a planted fake credential.

## Next steps, in order

1. **Install the APK on a real Fire TV / Android TV and phone** and run through the checklist in ANDROID.md. Then an iOS app (needs a Mac or Expo EAS with an Apple Developer account).
2. **On-device validation**: Fire TV Stick and an Android TV box (remote keys, performance), iOS Safari, Android Chrome.
3. **Online subtitles**: add an OpenSubtitles (or similar) API key to the server and a search endpoint that matches by TMDB/IMDb ID first and asks the user to confirm ambiguous results.
4. **Failure-injection tests** for stream recovery (kill upstream mid-stream, 403 from provider, offline toggles).
5. **Catch-up / timeshift** for channels where the provider advertises `tv_archive` (yours currently reports none).

## Where things are

- Run locally: `npm run dev` → http://localhost:5173. Production: `npm run build` then `npm start` → http://127.0.0.1:4870.
- Your real data lives in `data/` (gitignored). The provider from `.env.local` is already imported there. You'll be asked to create the owner password on first launch.
- Test data from this session was kept outside the project (a scratch folder) and can be discarded.
