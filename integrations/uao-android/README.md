# UAO for Android

A thin Capacitor shell. It does not contain UAO: it opens the tailnet-hosted
`uao-serve` (see `clients/desktop/deploy/uao-serve/`) in a WebView with
microphone access, so *Talk to Jarvis* works on the phone.

```
launcher page (www/index.html, https://localhost)
   └─ top-level navigation ─▶ https://server.tail85e19.ts.net:10000/uao-pair?token=…
                                   └─ 303 ─▶ /desktop/uao.html   (cookie set, UAO UI)
```

## How it behaves

- First launch shows a form. Paste the pairing link from the server (README of
  `uao-serve`, "Pair the phone") or the bare secret. It is kept in the app's
  private WebView storage, never in the APK.
- Every launch re-pairs (sets the session cookie again), so a lost cookie
  heals itself. If the server is unreachable (Tailscale off) it says so.
- Back from the server page returns to the launcher with *Try again* and
  *Change pairing secret* (use it after rotating the secret).
- Permissions: `INTERNET`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`. Capacitor's
  WebView client asks for the microphone at the first voice request and grants
  the page's `getUserMedia` only if both audio permissions are granted.
- `allowNavigation` is limited to `server.tail85e19.ts.net`; cleartext traffic,
  mixed content, backups and WebView debugging are off.

The server name appears in two places that must stay in step:
`capacitor.config.json` (`allowNavigation`) and `ORIGIN` in `www/index.html`,
plus `UAO_SERVE_ALLOWED_ORIGINS` on the server.

## Build a debug APK

Capacitor 8 needs JDK 21 (the default JDK here is 17/27). The repo does not
hardcode a path; point `JAVA_HOME` at a 21 for the build:

```bash
cd integrations/uao-android
bun install
export JAVA_HOME=/home/linuxbrew/.linuxbrew/opt/openjdk@21   # any JDK 21
bunx cap sync android
cd android && nice ./gradlew assembleDebug --no-daemon --max-workers=2
# -> android/app/build/outputs/apk/debug/app-debug.apk  (~4 MB)
```

Check the host first (`cat /proc/pressure/memory`); Gradle is capped at 1 GB
and two workers in `android/gradle.properties`. A debug build takes under a
minute when the box is calm.

## Install (sideload)

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to the phone and allow "install unknown apps". The phone must
be on the tailnet.

## Not done yet

- **Release signing.** The APK is signed with the Android debug key. A release
  build needs its own keystore (kept out of git; `*.keystore`/`*.jks` are
  ignored) and backed up, because losing it blocks updates.
- **App icon and splash** are Capacitor's defaults.
- **Tested on a device or emulator:** not yet. The launcher logic was tested in
  a browser and the server hand-off with matching headers, but the real
  WebView, the microphone prompt and Android back-button behaviour are
  unverified.
