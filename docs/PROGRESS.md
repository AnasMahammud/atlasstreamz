# ATLAS — progress and handoff

Last updated: 26 October 2026 (LG webOS app, older-TV browser support). "Verified" means exercised in this session against your real provider (9,876 live channels, 16,200 movies, 3,523 series, ~54,500 guide listings) in desktop Chromium, or covered by automated tests. Anything else is marked as unverified.

## New in this round

- **Online subtitles (OpenSubtitles).** The owner adds an OpenSubtitles API key, and optionally their account for its daily download allowance, in Settings → Subtitles (stored encrypted, never sent to devices). In the player, Subtitles → "Find subtitles online" lists matches in the profile's language (other languages one press away), found by the title's TMDB ID or, failing that, by name with the matched title shown for checking. The chosen file is converted to WebVTT and switched on; downloads are cached on the server so replays don't use the allowance. Works in the web player (desktop, phone, LG) and the Android app ("Find subtitles" button or the remote's Menu key; APK 0.3.2). OpenSubtitles.org's old API is retired, so this uses its successor at opensubtitles.com (same library).
- **LG webOS TVs.** `dist\ATLAS.ipk` (built by `apps\webos\build-webos.bat`, installed by `apps\webos\install-webos.bat` on a TV in Developer Mode) opens your ATLAS server in TV mode, like the Android app. It covers webOS 5 (2020) onwards. The remote's Back, media and channel keys work; Back from the first screens returns to the TV home; the Magic Remote pointer selects items. The launcher waits through a sleeping Render server and asks for another address if it can't connect. See [WEBOS.md](WEBOS.md).
- **Older TV browsers.** LG webOS 5, 6 and 22 run Chromium 68, 79 and 87, which lack `aspect-ratio`, flex `gap`, `clamp()`, `:focus-visible` and newer JavaScript. The web build now adds fallbacks for them (`apps/web/legacy-css.mjs`, `styles/legacy.css`, syntax compiled for Chromium 68 plus small polyfills); modern browsers are unaffected. Verified: no syntax newer than Chromium 68 in any chunk; in a simulation of Chromium 68's CSS at 1920×1080, Home, Movies and Live TV keep their layout, card shapes and spacing and the remote focus ring works; desktop and phone layouts unchanged; 9 new tests. **Not yet run on a real LG TV.**
- **Phones: no more miniature layout or pinch zoom.** Every row's grid track had stretched to its shelf's full width (5,778 px), so phones zoomed out to fit it. Rows are now capped at the screen width, the viewport is locked (no pinch or double-tap zoom, including iOS Safari), and text keeps a 16 px base. Verified at 375 px on all 13 screens in the browser pane.
- **Fire TV / Android TV: side menu, smooth scrolling, lighter rendering.** TV mode has a left side menu (Search, Home, Live TV, Guide, Movies, TV Shows, My List, Settings, profile) that stays on screen and opens when you press Left; Back jumps to it. Moving Down scrolls each row to the top of the screen instantly, and Right returns to the card you left. Blur, shadows, shimmer, ambient backgrounds and page animations are off on TV. The APK no longer uses "overview mode", which shrank the page, and zoom is disabled. Verified with arrow keys at 960×540 in TV mode; **not yet tried on a real Fire TV.**
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
| 5 Advanced features | **Done.** EPG timeline, typo-tolerant search, My List, PIN security, multi-profile personalisation, content-based recommendations, stream recovery, online subtitles from OpenSubtitles. |
| 6 Device optimisation | **Partial.** Responsive mobile and desktop, TV mode with spatial navigation and no live blur, Android APK with native playback, LG webOS app with fallbacks for older TV browsers. *Not done:* iOS app, Samsung Tizen; testing on real phones, TVs, Fire TV and LG TVs. |
| 7 Production readiness | **Partial.** Security review of auth flows, 72 automated tests, production build, PWA, Render blueprint and deploy script. *Not done:* native release builds, load testing. |

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
| 11 | Authorised external subtitles | Local `.srt`/`.vtt` import with styling and sync works. Online search through OpenSubtitles (owner's API key, matched by TMDB ID, name matches labelled for checking) is covered by 16 tests against a stand-in API; search parsing checked against real OpenSubtitles data. **Waiting for your API key** to try end to end. |
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
- Rows on Home and detail pages forced the page to 5,778 px wide, which made phones zoom out and the Fire TV WebView shrink the interface. Grid tracks are now `minmax(0, 1fr)`.
- On TV, Down from a row could jump into the side menu, because the collapsed menu links were still 212 px wide. Fixed, and the menu and content are now separate focus areas.
- The deploy script's credential scan failed open when `git grep` errored. It now stops on any scan error, and was proven against a planted fake credential.

## Next steps, in order

1. **Install the APK on a real Fire TV / Android TV and phone, and the IPK on an LG TV**, and run through the checklists in ANDROID.md and WEBOS.md. Then an iOS app (needs a Mac or Expo EAS with an Apple Developer account).
2. **On-device validation**: Fire TV Stick and an Android TV box (remote keys, performance), iOS Safari, Android Chrome.
3. **Online subtitles**: add your OpenSubtitles API key (and account) in Settings → Subtitles, then try "Find subtitles online" in the player.
4. **Failure-injection tests** for stream recovery (kill upstream mid-stream, 403 from provider, offline toggles).
5. **Catch-up / timeshift** for channels where the provider advertises `tv_archive` (yours currently reports none).

## Where things are

- Run locally: `npm run dev` → http://localhost:5173. Production: `npm run build` then `npm start` → http://127.0.0.1:4870.
- Your real data lives in `data/` (gitignored). The provider from `.env.local` is already imported there. You'll be asked to create the owner password on first launch.
- Test data from this session was kept outside the project (a scratch folder) and can be discarded.
