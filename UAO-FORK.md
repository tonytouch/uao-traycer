# UAO fork

`tonytouch/uao-traycer` is the spine of one UAO desktop. It is a fork of [Traycer](https://github.com/traycerai/traycer). Orca and Traycer features move here over time. [tonytouch/orca](https://github.com/tonytouch/orca) is the reference for behavior that has not moved yet.

Desktop and Android ship as **UAO**, application id `com.tonytouch.uao` (`uao/product.json`). The Traycer desktop package in `clients/desktop/package.json` is unchanged.

## Phases

1. **Agent OS** (done). The Agents hub has an Agent OS tab. It loads `http://100.90.167.20:5050/?embed=1#overview` (Hermes `:8787`, Omniroute `:20128`). It does not start a local backend. Endpoints can point the page at `127.0.0.1:5050` when one is already running. Tokens are written with Electron `safeStorage` under the desktop user-data directory and are not in git.
2. **CloudRoom** (done). The Agents hub has a CloudRoom tab next to Agent OS. It talks to `http://100.90.167.20:9840`: ready check, session list, start Codex / Claude Code / Pi / Cursor, and poll session events. It does not install or start CloudRoom. The token is written with Electron `safeStorage` in the Phase 1 token store and is not in git. The page only learns whether a token is saved. There is no SSE stream, steer, or interrupt.
3. **OpenMuse** (done). The Agents hub has an OpenMuse tab next to Agent OS and CloudRoom. It embeds `http://100.90.167.20:8081` in an Electron webview on `persist:openmuse`. Health is `GET http://100.90.167.20:8797/api/health`, and ready means `{"ok":true}`. UAO does not install or start OpenMuse, and it does not store the access key. The web and API URLs live in the Phase 1 endpoint file. Clearing the web URL unconfigures the page.
4. **Android and packaging** (done). Desktop `package:uao` and both Android shells use `com.tonytouch.uao` / **UAO**. See below for the build, cleartext, and the app id change.

## Try Agent OS

Open the UAO desktop, choose **Agents** in the sidebar, then **Agent OS**. The page is `http://100.90.167.20:5050/?embed=1#overview`. **Endpoints** in the Agents bar changes the address and stores Hermes, Omniroute, and Agent OS tokens. A failed load shows that URL and the error. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

## Try CloudRoom

Open the UAO desktop, choose **Agents** in the sidebar, then **CloudRoom**. The page uses `http://100.90.167.20:9840`. **Endpoints** in the Agents bar changes the address and stores the CloudRoom token. A failed load shows that URL and the error, with Retry. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

## Try OpenMuse

Open the UAO desktop, choose **Agents** in the sidebar, then **OpenMuse**. The page is `http://100.90.167.20:8081`. **Endpoints** in the Agents bar changes the web URL and the API URL. There is no token field. A failed load shows that URL and the error, with Retry. The API check can be degraded while the page still loads. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

Clearing the web URL unconfigures the OpenMuse tab. **Agents** stays in the sidebar, and **Endpoints** on that tab can set the URL again. Orca hides a separate OpenMuse row and edits the URL from the shared Agent OS form. This repo keeps that form on the Agent OS tab, so the OpenMuse tab keeps its own Endpoints editor. The last Agents tab is remembered on the next launch.

## Build desktop

From `clients/desktop`:

```bash
bun run package:uao
```

That builds the UAO main and renderer, then runs electron-builder with `electron-builder.uao.json` and `--publish never` (unsigned). Artifacts land in `clients/desktop/release-uao/` and are named `uao-desktop-…`. Linux is AppImage and tar.gz, x64. Mac is an unsigned arm64 zip (`identity` is null). The config does not name a Windows target. When publish is turned on, updates come from GitHub releases of `tonytouch/uao-traycer`. This PR does not create a release.

`uao/product.json` is the identity source. The builder's `appId`, product name, and GitHub repo match it.

## Build Android

Two shells share `com.tonytouch.uao`. Installing one replaces the other.

The gui-app shell (`clients/mobile`) is the Capacitor runner. JDK 21:

```bash
cd clients/mobile
bun run sync:android
cd android && ./gradlew assembleDebug
```

The pairing shell (`integrations/uao-android`) opens headless `uao-serve` after you paste the pairing link. Same JDK:

```bash
cd integrations/uao-android
bunx cap sync android
cd android && ./gradlew assembleDebug
```

There is no `google-services.json` in git. `clients/mobile/android/app/google-services.json.example` is a shape reference for package `com.tonytouch.uao`. Without the real file, the Google services plugin is not applied and push stays disconnected.

iOS stays `ai.traycer.app.ios` and `traycer://` in the checked-in Xcode project. `cap sync ios` is not part of this phase.

## Cleartext and the three remote pages

Agent OS `:5050`, CloudRoom `:9840`, and OpenMuse `:8081` load over `http://100.x`. Android cannot express `100.64.0.0/10` in a network security config, and `<domain>` does not match a raw IP, so release `network_security_config.xml` sets `base-config cleartextTrafficPermitted="true"` (the same approach as orca). The gui-app debug source set still allows cleartext only for `localhost`, `127.0.0.1`, and `10.0.2.2`.

The pairing shell also allows mixed content, because its page is `https` and the three embeds are `http`. The UAO shell Content-Security-Policy allows `http:` and `https:` frame and connect sources for those embeds. The Traycer desktop policy does not.

On Electron the pages stay in a `<webview>` guest. On Android and in a browser the same panes use an iframe, because a `<webview>` tag never finishes loading and the waiting overlay would sit on a blank page. Priority Features lists **Agents**. Agent OS, CloudRoom, and OpenMuse are tabs on that page, including on the phone. The phone reaches the same hub by pairing into the served UAO renderer (`/desktop/uao.html`). The gui-app shell still mounts the Traycer runner under the UAO name.

When the Electron preload is absent, the renderer keeps endpoint URLs and tokens in the page origin's `localStorage` (`uao.remote-pages.v1`). Desktop still uses `safeStorage`. Do not commit that store.

## App id migration

`appId` changed from `ai.uao.desktop` to `com.tonytouch.uao`. Electron's userData directory is named for the product, `UAO`, so the folder path does not move. Tokens encrypted with `safeStorage` are bound to the previous application id and do not decrypt after this change. Enter them again on first launch. Confirm the endpoint files in that userData directory still have the addresses you want. Nothing is copied out of an `ai.uao.desktop` identity.

## Deep links

`traycer://` stays the device-flow return scheme. Traycer authn's approval page emits `traycer://auth/callback`, and link-login still accepts the older `traycer://` payload. This repo cannot replace that page. Android also registers `uao://` (the desktop UAO protocol and `custom_url_scheme`). Headless-serve pairing does not use either scheme. It is `https://<tailscale-host>:10000/uao-pair?token=…`, and that hand-off is unchanged.

## Gaps versus orca

- Linux pacman is not a target here. It needs fpm, which this `package:uao` script does not install. AppImage and tar.gz are the Linux artifacts. The executable name stays `uao-desktop`.
- Mac stays an unsigned arm64 zip, which is what `package:uao` already produced. Orca builds a dmg.
- No React Native WebView. Android embeds the three pages in an iframe inside the UAO renderer.
- Phone tokens sit in `localStorage` on the page origin. Orca uses its own saved-endpoint store. Desktop tokens stay in `safeStorage`.
- iOS is still the Traycer bundle id.
- `traycer://` remains for Traycer sign-in. `uao://` is registered beside it and is not the pairing link.
