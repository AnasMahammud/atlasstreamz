# ATLAS for Android, Android TV and Fire TV

One APK (`dist\ATLAS.apk`) installs on Android phones and tablets (Android 6.0+), Android TV / Google TV, and Amazon Fire TV.

## How the app works

- **Interface**: the ATLAS interface from your ATLAS server, in a WebView. On TVs it switches to the remote-first layout: large focus states, D-pad navigation, no live blur. On phones it uses the touch layout with the bottom bar.
- **Playback**: native **Media3/ExoPlayer**, with hardware decoding, HLS, MPEG-TS, MP4 and MKV. Embedded audio and subtitle tracks are selectable from the player controls.
- **Remote**: Back closes menus and steps back (and exits from Home). Channel Up/Down, or D-pad Up/Down while controls are hidden, changes channel. Info/Guide shows the channel banner. The next episode plays automatically when your profile allows it.
- **Security**: video comes through your ATLAS server's proxy using your signed-in session, so your provider password never reaches the device. Only your ATLAS server's pages can use the app's native bridge.
- **Accounts**: everyone signs in with their own ATLAS account, so profiles, history and sources stay separate per person.

On first launch the app asks for your server address, for example `https://your-atlas.onrender.com` or `http://192.168.1.20:4870` on your home network. You can change it later under Settings → About → Change server.

## Install

### Phone or tablet
1. Copy `ATLAS.apk` to the phone (USB, Google Drive, email…).
2. Open it. Android asks you to allow installs from that app ("Install unknown apps"). Allow it, then tap Install.

### Fire TV
1. Settings → My Fire TV → Developer options → turn on **Apps from Unknown Sources** (newer Fire OS: **Install unknown apps** → allow *Downloader*).
2. Install the free **Downloader** app from the Amazon Appstore.
3. Put `ATLAS.apk` somewhere reachable by URL (for example a private Google Drive direct link, or your PC on the LAN), open that URL in Downloader and install.

The home-screen tile shows the ATLAS logo with the name beside it. Fire TV ignores the usual TV banner for apps not from the Amazon Appstore, so on TVs the app's launcher icon *is* the wide banner (`res/values-television/launcher.xml`); phones keep the round icon. Fire TV caches tiles, so if an update still shows the old tile, restart the Fire TV (Settings → My Fire TV → Restart), or uninstall and reinstall ATLAS (you'll need to sign in again).

### Android TV / Google TV
- Same as Fire TV with a file-manager or Downloader app, or with adb from this PC:

```bash
"%USERPROFILE%\.tools\android-sdk\platform-tools\adb.exe" connect 192.168.1.50:5555
```

```bash
"%USERPROFILE%\.tools\android-sdk\platform-tools\adb.exe" install -r "dist\ATLAS.apk"
```

(Enable *Developer options → USB/Network debugging* on the TV first; use its IP address.)

## Rebuild

Prerequisites (already installed on this PC under `%USERPROFILE%\.tools`): JDK 17 and the Android SDK (platform 35, build-tools 35).

Double-click `apps\android\build-apk.bat`, or bake your server address in so nobody has to type it:

```bash
apps\android\build-apk.bat https://your-atlas.onrender.com
```

The first build creates a release signing key in `apps\android\keystore\` (gitignored). **Back up that folder and `apps\android\keystore.properties`**: Android only installs an update over an existing app when it is signed with the same key.

## Not yet verified

The APK was built and its manifest, signature and contents were checked on this PC. It has **not** been run on a phone, Android TV or Fire TV here, because there is no device or emulator. Things to check on first install:

- First-run connect screen with a remote (type the address with the on-screen keyboard).
- Sign-in, profile selection and browsing with the D-pad.
- Live playback and channel up/down; a movie and an episode with resume.
- Back behaviour in the player and on Home.
- Older Fire TV models ship an older WebView. A few visual effects (the profile glow) may not appear there; everything stays usable.
