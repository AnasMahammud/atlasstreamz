# Technical decisions

## Environment (October 2026)

- Windows 11, Git Bash. **PowerShell is blocked by group policy.** Node.js was not installed; with your approval a portable Node 22.23.4 LTS zip was downloaded from nodejs.org (SHA-256 verified) into `%USERPROFILE%\.tools`. `scripts/node-env.sh` puts it on PATH.
- No Java, Android SDK, Xcode or macOS here, so native Android/iOS builds can't be produced in this environment. See BUILD.md.

## Accounts (multi-user)

- Every person has their **own account** (email + password) with their own profiles, PINs, history, My List, recommendations **and content sources**. The server owner is the first account; others join by invite link (default), open sign-up, or not at all (Settings → Members).
- Each account sees only the catalogue of its own sources: every catalogue query, search, detail, play and stream request checks that the content's provider belongs to the signed-in account (tests cover this).
- The owner's provider is deliberately **not shared** with other accounts. It would put strangers on your subscription and its 2-stream limit, and amount to redistributing the provider's streams. People in the same household can still use your account with their own profiles.
- On public deployments (`ATLAS_PUBLIC=true`), the server refuses to fetch private, loopback or cloud-metadata addresses, checking each redirect hop too. This stops a member's "playlist URL" from being used to probe Render's internal network.
- Version 1 data migrates automatically: the single owner becomes the owner account (sign in as `owner`), keeping profiles and sources.

## Android app

- One APK for phones, Android TV and Fire TV: a WebView shell around the same ATLAS interface (already remote-first with spatial navigation) plus a **native Media3/ExoPlayer player** for hardware decoding, MKV/TS, embedded tracks and remote media keys. A WebView `<video>` alone would not match native TV playback.
- The native player streams through the ATLAS proxy with the WebView's session cookie, so provider credentials never reach the device.
- Only pages from the configured ATLAS server (or the bundled connect screen) may call the native bridge.
- Written in Java with no Kotlin or AppCompat dependency, which keeps the build small and dependable. Media3 1.5.1, compileSdk/targetSdk 35, minSdk 23.

## Architecture: home server + clients

IPTV credentials are embedded in every stream URL. A pure client app would ship them to every device and every browser bundle. ATLAS instead runs a small **server** that:

- stores provider secrets with AES-256-GCM (key in `data/secret.key`, gitignored);
- resolves streams server-side and proxies them. HLS playlists are rewritten so every segment, variant and key URL is an opaque encrypted token. The browser never sees a provider host, username or password;
- redacts usernames, passwords and `/live/user/pass/` path segments from all logs;
- enforces one continuous stream per session, closing the previous upstream on channel change, so ATLAS stays inside the provider's connection limit (this provider allows 2).

Clients (web now, native later) only talk to the ATLAS API. This also solves CORS and mixed content, since most panels are HTTP-only and send no CORS headers.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | One domain model across server, web and future React Native apps. |
| Shared logic | `@atlas/core`, zero dependencies | Runs in Node, browsers and React Native unchanged. |
| Server | Fastify 5 on Node 22, run with `tsx` | Small, fast, good raw-stream control (`reply.hijack`). |
| Database | `node:sqlite` (built into Node 22) | No native module to compile on Windows/ARM; FTS5 and WAL available. Loaded through `createRequire` because some tooling doesn't yet know prefix-only built-ins. |
| Sync | `worker_threads` with its own SQLite connection | A 50 MB playlist parse never blocks stream proxying. |
| Web | React 18 + Vite 6, React Router, TanStack Query/Virtual, Zustand, Framer Motion | Mature, fast, works on TV browsers. |
| Playback | hls.js (HLS), mpegts.js (raw MPEG-TS), native `<video>` (MP4/MKV) | The server lists engines in preference order; the player falls back through them. |

## Provider integration

- A `get.php?username=&password=` link is recognised as an **Xtream** panel and synced through `player_api.php`, which is richer (categories, TMDB artwork, ratings, series info, account expiry, allowed formats). Plain M3U files use the streaming M3U parser.
- **Stable IDs** are `provider:kind:streamId`, never list positions. Favourites and progress also store a `matchKey` (normalised title + year). If a provider re-issues an ID, the next sync moves the user's data to the new ID.
- **Atomic sync**: every row is tagged with the sync run, unseen rows are deleted, and it all happens in one transaction. An empty catalogue is rejected so a provider outage can't wipe your library. Guide failures don't fail the catalogue sync.
- Scheduling: every 24 h after success; on failure 5 min, 10, 20 … capped at 6 h. Checked at start-up and every 5 minutes, so a machine that slept catches up. Exact timing is not promised.
- Movie/series details (plot, cast, backdrops, episodes) are fetched **on demand** and cached for 7 days. After each sync a few recent movies are enriched so Home has hero artwork.
- **Plain HTTP providers need explicit consent** (`http_consent`). Until you allow it, ATLAS will not sync from or play the provider, and the UI explains the risk.

## Honesty rules built into the product

- Quality badges come only from **measured** playback (`videoWidth`/`videoHeight` reported by the player, letterbox-aware). Provider labels like "4K" or "FHD" are shown as "· provider" claims, never as verified.
- Ratings are labelled as provider-supplied. Rows only appear when they have content. "Highly Rated Series" is used instead of "Popular", because the provider supplies no popularity data.
- Alternate feeds for a channel are **offered** with their category after a failure, never switched silently. ATLAS does not scrape the web for streams.
- Online subtitle search is not enabled: it needs an authorised subtitle-service API key. Local `.srt`/`.vtt` import, styling and sync offset work.

## Design

- Visual direction follows your references: a floating glass pill nav centred at the top (instead of the brief's side rail), large section titles, 16:9 continue-watching cards with in-art progress, 2:3 posters with an orange "new" dot, white focus ring with lift, and a full-bleed Apple TV–style hero.
- Liquid Glass = translucent fill + backdrop blur/saturate + a gradient specular rim (mask-composited hairline) + top sheen. **TVs get no live blur**: Fire TV sticks can't afford it, so glass becomes tinted solid. "Reduce transparency" does the same on any device.
- The ambient background takes a blurred, low-resolution copy of the focused artwork plus an accent colour extracted from a 12×12 canvas sample (cached per URL).
- Focus engine (`lib/focus.ts`): geometric spatial navigation with per-shelf focus memory, focus traps for dialogs and the player, and a back-handler stack for remotes. Mouse hover moves focus, so hover and remote focus look identical.
- Motion: spring presets shared via `@atlas/core` tokens. `prefers-reduced-motion` and the in-app toggle collapse everything to fades. App-level wrappers animate **opacity only**, because a filter or transform there would break `position: fixed`.

## Security

- Owner password and PINs: scrypt (N=16384) with per-secret salts. PIN lockout after 5 failures with doubling waits (30 s → 1 h), stored server-side.
- Sessions: random 256-bit tokens, stored hashed, httpOnly + SameSite=Strict cookies, 30-day expiry, listed and revocable in Settings.
- CSRF: state-changing requests with a foreign `Origin` are rejected.
- Settings can be PIN-locked per profile. Kids profiles need the owner password to leave Kids mode.
