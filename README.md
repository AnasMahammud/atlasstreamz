# ATLAS — Your Universe of Entertainment

A premium, cinematic streaming app for your own IPTV and on-demand sources: live TV with a real programme guide, movies, series, profiles with PINs, and a Liquid Glass interface built for TVs, desktops and phones.

ATLAS has two parts:

| Part | What it does |
| --- | --- |
| **ATLAS server** (`apps/server`) | Runs on a computer in your home. Stores your provider credentials **encrypted**, syncs playlists/EPG every 24 h, serves the catalogue API, and proxies streams so credentials never reach a browser or TV. |
| **ATLAS web app** (`apps/web`) | The interface. Works in desktop and mobile browsers, installs as a PWA, and has a remote-first TV mode (`?device=tv`, auto-detected on Android TV / Fire TV / smart-TV browsers). |
| **ATLAS for Android** (`apps/android`) | One APK for phones, Android TV and Fire TV: the ATLAS interface plus a native Media3 player. Build with `apps\android\build-apk.bat`; install guide in [docs/ANDROID.md](docs/ANDROID.md). |
| **@atlas/core** (`packages/core`) | Platform-neutral logic shared by everything: M3U / Xtream / XMLTV parsing, normalisation, search, recommendations, design tokens. Native apps will reuse it. |

Status: see [docs/PROGRESS.md](docs/PROGRESS.md). Build and platform notes: [docs/BUILD.md](docs/BUILD.md). Why things are the way they are: [docs/DECISIONS.md](docs/DECISIONS.md).

## Quick start (Windows, this machine)

Node.js is installed portably in `%USERPROFILE%\.tools\node-v22.23.4-win-x64`. In Git Bash:

```bash
source scripts/node-env.sh
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. On first launch ATLAS asks you to:

1. create the **owner account** (email + password). Other people get their own accounts via invite links from Settings → Members;
2. review the provider configured in `.env.local` — it only supports **unencrypted HTTP**, so ATLAS asks for your permission before using it;
3. wait ~15 s while the catalogue and guide import, then create profiles.

### Production

```bash
npm run build
```

```bash
npm start
```

The server then serves the web app itself on http://127.0.0.1:4870. To use ATLAS from a TV or phone on your network, set `ATLAS_HOST=0.0.0.0` in `.env.local` (see the security note in [docs/BUILD.md](docs/BUILD.md)).

### Online with Render

Double-click `deploy-to-render.bat`. It checks that no secrets can be published, runs the tests and build, creates a private GitHub repository and uploads the project, creates the Render web service, waits until it's live and opens your website. Read the costs and limits in [docs/BUILD.md](docs/BUILD.md#put-atlas-online-with-render) first: the persistent disk needs a paid instance, and streamed video counts against Render bandwidth.

## Configuration

`.env.local` (gitignored — never commit it):

| Variable | Purpose |
| --- | --- |
| `ATLAS_INITIAL_M3U_URL` | Playlist imported once on first start, then stored encrypted in `data/`. Xtream `get.php` links are detected and use the richer Xtream API. |
| `ATLAS_INITIAL_PROVIDER_NAME` | Display name for that source. |
| `ATLAS_HOST` / `ATLAS_PORT` | Bind address (default `127.0.0.1:4870`). |
| `ATLAS_DATA_DIR` | Where the database, encryption key and artwork cache live (default `./data`). |
| `ATLAS_SETUP_TOKEN` | Optional. When set, creating the owner account requires this code (used on Render). |
| `ATLAS_SECURE_COOKIES` / `ATLAS_TRUST_PROXY` | Set to `true` / `1` behind an HTTPS proxy such as Render. |
| `PORT` | Used when `ATLAS_PORT` isn't set (hosting platforms assign it). |

## Tests

```bash
npm test
```

53 automated tests: playlist/EPG parsing edge cases, Xtream normalisation, duplicate channels, time zones, typo-tolerant search, recommendations, PIN rules and lockout, profile separation, atomic catalogue sync with favourite re-matching, HLS playlist rewriting and log redaction.

## Repository layout

```
apps/
  server/        Fastify + node:sqlite backend, sync worker, stream proxy
  web/           React + Vite app (desktop, mobile, TV, PWA)
packages/
  core/          Shared TypeScript domain logic (no dependencies)
assets/brand/    Generated icons: iOS, Android adaptive, Android TV banner, Fire TV, splash
scripts/         dev launcher, icon generator, Node PATH helper
docs/            Progress, decisions, build & distribution
```
