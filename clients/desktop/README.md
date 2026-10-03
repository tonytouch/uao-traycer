# UAO Desktop Shell

Standalone Electron desktop package for **Ultimate Agent OS (UAO)**.
Launches the bundled UAO renderer without Vite, Traycer Host, cloud authentication, or CLI provisioning.

---

## 1. Backend Requirement

UAO Desktop connects to the existing UAO backend running locally:

- **Address:** `http://127.0.0.1:5050`
- **Role:** Serves the backend API and the built tool iframes (`/assets/`, `/hermes-webui/`, etc.).
- **Authentication (Optional):** If token authentication is configured, set the `AGENT_OS_TOKEN` environment variable before launching the desktop executable:
  ```bash
  export AGENT_OS_TOKEN="your-token"
  ```
- **Resilience:** If the backend is temporarily offline, the desktop shell still loads immediately and displays the retryable disconnected status screen.

---

## 2. Build Commands

From `clients/desktop/`:

```bash
# Build both the UAO main process and renderer bundles
bun run build:uao

# Build unpacked Linux directory (fast local smoke test)
bun run package:uao:dir

# Package standalone Linux AppImage executable
bun run package:uao
```

---

## 3. Launching Packaged Executables

No environment flags or command-line arguments are required to start UAO mode.

### Unpacked directory:
```bash
./clients/desktop/release-uao/linux-unpacked/uao-desktop
```

### AppImage:
```bash
chmod +x ./clients/desktop/release-uao/uao-desktop-linux-x86_64.AppImage
./clients/desktop/release-uao/uao-desktop-linux-x86_64.AppImage
```

---

## 4. Architecture & Security Invariants

- **Internal Loopback Server:** Binds to `127.0.0.1` on an ephemeral port. Serves compiled desktop assets under `/desktop/` (preventing collision with backend `/assets/`), and proxies bounded prefixes to `127.0.0.1:5050` with `/uao-api` stripped.
- **Request Boundary Validation:** Enforces strict `127.0.0.1` / `localhost` Host and Origin validation. Rejects path traversal, null bytes, symlinks pointing outside the packaged root, unexpected methods (GET/HEAD only for static assets), and root `/sw.js` service-worker takeover.
- **Content-Security-Policy (CSP):** The shell enforces `frame-src 'self'` matching the built `<meta>` tag and response headers. Upstream CSP policies are preserved on proxied documents.
- **Sandboxed Electron:** Runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. No preload bridge is loaded.
