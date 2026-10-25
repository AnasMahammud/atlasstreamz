# Build & distribution

| Platform | Status | Artifact produced here? |
| --- | --- | --- |
| Web (desktop, mobile browsers) | Working | `apps/web/dist` (via `npm run build`) |
| PWA install | Manifest, icons and service worker in place | Same build |
| TV browsers (Android TV / Fire TV / smart TVs) | Remote-first TV mode works in Chromium | Same build; needs on-device validation |
| Android phone / tablet, Android TV, Fire TV | **Built**: one signed APK (WebView interface + native Media3 player) | Yes, `dist\ATLAS.apk` via `apps\android\build-apk.bat`. Not yet run on a device; see [ANDROID.md](ANDROID.md) |
| iOS / iPadOS IPA | **Not built** | No — requires macOS + Xcode or EAS cloud build with an Apple Developer account |

The Android APK is built (see [ANDROID.md](ANDROID.md)). No AAB (Play Store bundle) or iOS IPA has been produced. The iOS section below is a plan with exact requirements, not a completed build.

## Web

Dev (server on :4870 with reload, web on :5173 with HMR):

```bash
npm run dev
```

Production bundle (lazy-loads the player engines only when the player opens):

```bash
npm run build
```

Serve API and app from one process:

```bash
npm start
```

### Reaching ATLAS from a TV or phone

Set `ATLAS_HOST=0.0.0.0` in `.env.local` and open `http://<this-pc-ip>:4870` on the device. Over your LAN this is plain HTTP, the same as the provider. For access outside your home, put ATLAS behind an HTTPS reverse proxy (for example Caddy with automatic certificates) instead of opening the port directly. The session cookie should then be marked `secure` (`apps/server/src/app.ts`, `setSessionCookie`).

## Put ATLAS online with Render

Double-click **`deploy-to-render.bat`** in the project folder. On the first run it does everything:

1. checks Git and the portable Node.js, refuses to continue if `.env.local`, `data/` or the Android signing key could be published, then runs the tests and the production build;
2. signs you in to GitHub in your browser (Git Credential Manager; no token to copy), creates a **private** repository and uploads the project;
3. asks for a Render API key (a browser tab opens on the right page) and lets you choose **Starter + 1 GB disk** (paid, recommended) or **Free** (data is wiped on every restart). It asks you to confirm before creating anything paid;
4. creates the Render web service with all its settings. Your playlist link from `.env.local` goes to Render as an encrypted setting, only after you confirm;
5. waits until the website is live, then shows its address and the one-time **setup code** and opens it in your browser.

Afterwards, every run just commits and pushes, and Render redeploys automatically. The repository name, Render service and setup code are remembered in `deploy.local.json` (gitignored). The Render API key is never stored.

Two things the script can't do for you: create your Render account, and give Render access to your GitHub. If Render can't see the new private repository, the script opens the page to connect GitHub and waits for you to retry.

To check everything without publishing:

```bash
deploy-to-render.bat --check
```

To also preview the GitHub and Render steps without doing them:

```bash
deploy-to-render.bat --dry-run
```

`render.yaml` describes the same service as a Render Blueprint, if you'd rather create it from the Render dashboard.

What happens on Render:

- **Your provider link is never in the repository.** It is stored by Render as an encrypted environment variable, then imported once into the owner account's encrypted database on the disk. Other accounts can't use it; each person adds their own source.
- **Claiming the server needs a setup code.** The deploy script generates `ATLAS_SETUP_TOKEN` and shows it to you (it's also in `deploy.local.json` and under *atlas → Environment* in Render). The first-run screen asks for it, so nobody who stumbles on the URL can create the owner account before you.
- HTTPS is provided by Render. Session cookies are marked `Secure`, and sign-in rate limits use the real client IP (`ATLAS_TRUST_PROXY=1`).
- Use a long owner password: the sign-in page is on the public internet.

Costs and limits to know before you go live:

- **Plan**: the blueprint uses the paid *Starter* instance because persistent disks aren't available on the free plan. On the free plan the database (owner account, profiles, history) would be wiped on every deploy or restart, and the service sleeps when idle.
- **Bandwidth**: every stream is proxied through the server so credentials never reach the browser. All the video you watch therefore counts as Render outbound bandwidth, and HD video uses several GB per hour. Check Render's current bandwidth allowance and pricing.
- **Provider access**: many IPTV providers block datacenter IP ranges. If channels play at home but not on Render, the provider is refusing Render's servers, not ATLAS. The provider's 2-stream limit applies across all your devices.

### PWA

`apps/web/public/manifest.webmanifest`, icons in `apps/web/public/icons`, and `sw.js`. The service worker caches the app shell (cache-first), catalogue API responses (network-first with offline fallback) and artwork (cache-first, 600 images max). Streams are never cached. Browsers only allow installation from `https://` or `localhost`.

## Brand assets

```bash
node scripts/build-icons.mjs
```

This writes PWA icons, iOS 1024 px, Android legacy plus adaptive foreground/background for every density, Play Store 512 px, the Android TV banner (320×180, 640×360), Fire TV icons (1280×720, 512) and a 2048 px splash, all into `assets/brand/`.

## Native apps: plan and exact requirements

The native apps should be thin clients of the ATLAS server API, reusing `@atlas/core` for models, search and recommendations, with native players:

- **Android, Android TV, Fire TV**: React Native via the `react-native-tvos` fork (Expo SDK with TV config plugin). It handles D-pad focus natively, plays through `react-native-video` on **Media3/ExoPlayer** (HLS, MPEG-TS, MKV, hardware decoding, HDR passthrough where the device supports it), and uses `assets/brand/android-tv/banner-*.png` as the Leanback launcher banner (`android:banner`).
- **iPhone, iPad**: the same React Native app on AVPlayer. AVPlayer does not play MKV or raw MPEG-TS, so ask the provider for HLS (`output=m3u8`; this provider allows it) or add a server-side remux.

Requirements before any native build can be attempted:

1. **Android**: JDK 17, Android SDK (platform 35, build-tools 35), Android Studio or command-line tools, and `ANDROID_HOME` set. Debug APK: `npx expo run:android --variant debug`. Release: create a keystore with `keytool -genkeypair -v -keystore atlas-release.keystore -alias atlas -keyalg RSA -keysize 2048 -validity 10000`, configure signing in `android/app/build.gradle` (keep the keystore and passwords out of git), then `./gradlew assembleRelease` (APK) or `./gradlew bundleRelease` (AAB).
2. **Android TV / Fire TV**: the same build with `<uses-feature android:name="android.software.leanback" android:required="false"/>`, `<uses-feature android:name="android.hardware.touchscreen" android:required="false"/>`, a `LEANBACK_LAUNCHER` intent category and the banner. Sideload to Fire TV with `adb connect <ip>` then `adb install app-release.apk`.
3. **iOS**: a Mac with Xcode 16+ and an Apple Developer Program membership, or Expo EAS cloud build (`eas build -p ios`) with that membership. An IPA is distributed through TestFlight or ad-hoc provisioning with registered device UDIDs.

## Hardware validation still required

These have been verified in desktop Chromium only and need real devices:

- D-pad and remote keys on Android TV and Fire TV browsers (Back keycodes 461/10009, channel up/down, media keys).
- Performance of the no-blur TV theme on a Fire TV Stick (memory, 60 fps focus animation).
- iOS Safari native HLS path, safe-area insets and fullscreen behaviour.
- MKV playback: works in desktop Chromium; Safari and many TV browsers can't play MKV. The player then shows an "unsupported format" message rather than failing silently.
- HDR / Dolby Vision: not handled by the web player beyond what the browser does natively. Quality badges never claim HDR.
