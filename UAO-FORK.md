# UAO fork

`tonytouch/uao-traycer` is the spine of one UAO desktop. It is a fork of [Traycer](https://github.com/traycerai/traycer). Orca and Traycer features move here over time. [tonytouch/orca](https://github.com/tonytouch/orca) is the reference for behavior that has not moved yet.

The app id and display name stay as they are on this branch until the packaging phase.

## Phases

1. **Agent OS** (done). The desktop sidebar has an Agent OS page. It loads `http://100.90.167.20:5050/?embed=1#overview` (Hermes `:8787`, Omniroute `:20128`). It does not start a local backend. Endpoints can point the page at `127.0.0.1:5050` when one is already running. Tokens are written with Electron `safeStorage` under the desktop user-data directory and are not in git.
2. **CloudRoom** (done). The desktop sidebar has a CloudRoom page next to Agent OS. It talks to `http://100.90.167.20:9840`: ready check, session list, start Codex / Claude Code / Pi / Cursor, and poll session events. It does not install or start CloudRoom. The token is written with Electron `safeStorage` in the Phase 1 token store and is not in git. The page only learns whether a token is saved. There is no SSE stream, steer, or interrupt.
3. **OpenMuse** (done). The desktop sidebar has an OpenMuse page next to Agent OS and CloudRoom. It embeds `http://100.90.167.20:8081` in an Electron webview on `persist:openmuse`. Health is `GET http://100.90.167.20:8797/api/health`, and ready means `{"ok":true}`. UAO does not install or start OpenMuse, and it does not store the access key. The web and API URLs live in the Phase 1 endpoint file. Clearing the web URL unconfigures the page.
4. **Android and packaging.** Rebrand to `com.tonytouch.uao`.

## Try Agent OS

Open the UAO desktop and choose **Agent OS** in the sidebar. The page is `http://100.90.167.20:5050/?embed=1#overview`. **Endpoints** on that page changes the address and stores Hermes, Omniroute, and Agent OS tokens. A failed load shows that URL and the error. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

## Try CloudRoom

Open the UAO desktop and choose **CloudRoom** in the sidebar, under Priority Features next to Agent OS. The page uses `http://100.90.167.20:9840`. **Endpoints** on that page changes the address and stores the CloudRoom token. A failed load shows that URL and the error, with Retry. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

## Try OpenMuse

Open the UAO desktop and choose **OpenMuse** in the sidebar, under Priority Features next to Agent OS and CloudRoom. The page is `http://100.90.167.20:8081`. **Endpoints** on that page changes the web URL and the API URL. There is no token field. A failed load shows that URL and the error, with Retry. The API check can be degraded while the page still loads. A new Tailscale `http://100.x` address is treated as cleartext on the next launch.

Clearing the web URL hides the sidebar row while an OpenMuse tab is open. The tab stays, so Endpoints can set the URL again. If that tab is closed and the URL is still blank, the row comes back. Orca leaves the row hidden and edits the URL from the shared Agent OS form. This repo leaves that form unchanged, so a blank URL with no OpenMuse tab would otherwise have no editor.
