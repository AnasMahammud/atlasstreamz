# ATLAS for LG webOS TVs

`dist\ATLAS.ipk` installs ATLAS on LG smart TVs running **webOS 5 or newer** (2020 models onwards; webOS 4 and older lack CSS Grid, which the interface needs).

## How the app works

- **Interface**: the app is a small launcher that opens your ATLAS server, like the Android app. The interface comes from the server, so every deploy updates the TV too. It opens in the TV layout: the left side menu, large focus states and remote navigation.
- **First launch**: it opens the Render address from your last deploy (built in). If the server is asleep (Render's free plan), it shows "Waking up the server…" for up to a minute. If it can't reach the server, it shows an address box: type another address with the on-screen keyboard and press Connect. The last address that worked is remembered.
- **Remote**: arrows and OK move around; **Back** closes menus, moves to the side menu, then returns to the TV's home screen. Play, Pause, Stop, Fast-forward and Rewind work in the player; CH+/CH− change channel. The Magic Remote's pointer works too: point at a card or menu item to select it.
- **Playback**: in the TV's browser engine, through your server's stream proxy, like the website (HLS via hls.js, MPEG-TS via mpegts.js). Your provider password never reaches the TV.
- **Older LG TVs**: webOS 5, 6 and 2022 TVs run old browser engines (Chromium 68, 79 and 87). The web build adds fallbacks for them, so layout, spacing, artwork shapes and the remote focus ring still work. See "Older TV browsers" below.

## Install (Developer Mode)

LG only installs apps from the LG Content Store, or from a PC to a TV in **Developer Mode**. Developer Mode is free.

1. **Make an LG developer account** at [webostv.developer.lge.com](https://webostv.developer.lge.com) (Sign In → Create Account).
2. **On the TV**, open the LG Content Store, install **Developer Mode**, open it and sign in with that account.
3. Turn **Dev Mode Status** ON (the TV restarts), open Developer Mode again and turn **Key Server** ON. Leave the app open: it shows the TV's **IP address** and a **Passphrase**.
4. **On this PC** (same network as the TV), build the app once:
   ```bash
   apps\webos\build-webos.bat
   ```
   The first run installs LG's webOS command-line tools into `%USERPROFILE%\.tools\webos-cli` (about two minutes).
5. Install it:
   ```bash
   apps\webos\install-webos.bat
   ```
   Type the TV's IP address, then the Passphrase when asked. ATLAS installs, opens, and appears in the TV's app list.

To update the app later, run steps 4–5 again. Interface changes need only a deploy (`deploy-to-render.bat`); the TV picks them up next time ATLAS opens.

### Developer Mode expires

Developer Mode runs for a limited time; the Developer Mode app shows the hours left (recent TVs show about 1,000 hours). Open it and press **Extend** before it runs out. If it expires, the TV removes apps installed this way and you need to repeat the install. ([LG's guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app))

### Without Developer Mode

- Publishing to the **LG Content Store** removes the time limit, but needs an LG seller account and LG's review.
- The TV's own **web browser** can open your Render site directly. It works, but the browser's pointer and toolbar get in the way of remote navigation.

## Build options

```bash
apps\webos\build-webos.bat https://your-atlas.onrender.com
```

Builds the app for a different server address (for example a home server: `http://192.168.1.20:4870`). With no address and no previous deploy, the app asks on first launch.

## Older TV browsers

webOS 5 (Chromium 68), webOS 6 (79) and webOS 22 (87) are missing CSS and JavaScript features the interface uses. The web build adds fallbacks for them; modern browsers ignore these.

- **CSS fallbacks** (`apps/web/legacy-css.mjs`): plain values for `clamp()`/`min()`/`max()` worked out for a 1920×1080 TV, expanded `inset`, `:focus` copies of `:focus-visible` rules, and margins in place of flex `gap`.
- **Card shapes** (`styles/legacy.css`): fixed shapes for cards on TVs without `aspect-ratio`.
- **JavaScript**: syntax compiled for Chromium 68, plus small polyfills (`globalThis`, `queueMicrotask`, `flatMap`).

Verified on this PC:

- Every built chunk contains only syntax Chromium 68 can run.
- In a simulation of Chromium 68's CSS support at 1920×1080, Home, Movies and Live TV keep their layout, card shapes and spacing, and the remote focus ring works.

**Not yet run on a real LG TV or the webOS emulator.**

## Checklist for the first run on a TV

- [ ] Launch shows the ATLAS splash, then the profile picker or Home.
- [ ] Arrows move focus; the side menu opens with Left; Back goes side menu → TV home.
- [ ] Posters keep their shape and spacing (older TVs).
- [ ] A live channel and a movie play; Play/Pause/Stop keys work; CH+/CH− change channel.
- [ ] Magic Remote pointer selects cards and menu items.
