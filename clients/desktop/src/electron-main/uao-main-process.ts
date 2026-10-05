import { app, BrowserWindow, session } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_DEFAULT_HERMES_URL,
  AGENT_OS_DEFAULT_OMNIROUTE_URL,
  tailscaleCleartextOrigins,
} from "@traycer-clients/shared/agent-os-endpoints";
import { CLOUDROOM_DEFAULT_BASE_URL } from "@traycer-clients/shared/cloudroom";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
} from "@traycer-clients/shared/openmuse";
import { initLogger, log } from "./app/logger";
import {
  clampSessionTls,
  installNavigationGuard,
  installPermissionHandlers,
  safelyOpenExternal,
} from "./app/security";
import {
  UAO_CONTENT_SECURITY_POLICY,
  isUaoProxyDocument,
} from "../shared/content-security-policy";
import { startUaoServer, type UaoServerInstance } from "./uao-server";
import { prepareUaoOffice, attachUaoOffice } from "./uao-office";
import { attachAgentOs } from "./agent-os-service";
import { attachCloudroom } from "./cloudroom-service";
import { attachOpenMuse } from "./openmuse-service";
import { collectUaoCleartextSwitch } from "./cloudroom-store";

/**
 * Remote backend, e.g. a Mac reaching the Linux box over Tailscale. Env wins;
 * otherwise `<userData>/backend.json`:
 *   {"host": "...", "port": 5050}          dial the backend directly, or
 *   {"upstream": "https://<name>.ts.net:10000/"}   go through that machine's
 *     uao-serve gateway, paired with `<userData>/pairing-secret`
 *     (UAO_UPSTREAM / UAO_PAIRING_SECRET override). The butler's /ask and
 *     /speak only accept loopback callers, which the gateway is.
 */
function resolveBackendTarget(): {
  host?: string | undefined;
  port: number;
  upstream?: { url: string; pairingSecret: string } | undefined;
} {
  const userData = app.getPath("userData");
  let host = process.env.UAO_BACKEND_HOST;
  let port = Number(process.env.UAO_BACKEND_PORT ?? "5050");
  let upstream = process.env.UAO_UPSTREAM;
  try {
    const file = JSON.parse(
      readFileSync(join(userData, "backend.json"), "utf8"),
    ) as { host?: unknown; port?: unknown; upstream?: unknown };
    if (host === undefined && typeof file.host === "string") host = file.host;
    if (typeof file.port === "number") port = file.port;
    if (upstream === undefined && typeof file.upstream === "string")
      upstream = file.upstream;
  } catch {
    // No config file: use env or the local backend.
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UAO backend port must be a valid port.");
  }
  if (upstream !== undefined && upstream !== "") {
    let secret = process.env.UAO_PAIRING_SECRET;
    if (secret === undefined) {
      try {
        secret = readFileSync(join(userData, "pairing-secret"), "utf8").trim();
      } catch {
        throw new Error(
          "UAO upstream needs a pairing secret: put it in <userData>/pairing-secret.",
        );
      }
    }
    return { port, upstream: { url: upstream, pairingSecret: secret } };
  }
  return { host: host === "" ? undefined : host, port };
}

let uaoWindow: BrowserWindow | null = null;
let serverInstance: UaoServerInstance | null = null;

/**
 * Linux Electron treats a plain-http Tailscale address as an insecure origin.
 * Mark the saved 100.64/10 http origins secure before ready so Agent OS,
 * CloudRoom, and OpenMuse can use them. This does not allow arbitrary cleartext.
 */
function installUaoCleartext(): void {
  let value = tailscaleCleartextOrigins([
    AGENT_OS_DEFAULT_BASE_URL,
    AGENT_OS_DEFAULT_HERMES_URL,
    AGENT_OS_DEFAULT_OMNIROUTE_URL,
    CLOUDROOM_DEFAULT_BASE_URL,
    OPENMUSE_DEFAULT_WEB_URL,
    OPENMUSE_DEFAULT_API_URL,
  ]);
  try {
    value = collectUaoCleartextSwitch(app.getPath("userData"));
  } catch {
    // Defaults above still cover Keith's host when userData cannot be read yet.
  }
  if (value.length > 0) {
    app.commandLine.appendSwitch(
      "unsafely-treat-insecure-origin-as-secure",
      value,
    );
  }
}

function hardenUaoSession(serverOrigin: string): void {
  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession);
  clampSessionTls(defaultSession);

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    if (
      isUaoProxyDocument(details.url, serverOrigin) ||
      details.url.startsWith("genoffice-app:") ||
      details.url.startsWith("genoffice-docx-media:") ||
      details.url.startsWith("html-preview:") ||
      details.url.startsWith("html-asset:")
    ) {
      callback({ responseHeaders: headers });
      return;
    }
    headers["Content-Security-Policy"] = [UAO_CONTENT_SECURITY_POLICY];
    callback({ responseHeaders: headers });
  });
}

app.setName("UAO");
// Cookie encryption stays off the OS keyring. Chromium otherwise asks for that
// key at startup and blocks every window when the keyring is locked or missing.
// Agent OS and CloudRoom tokens use safeStorage only when the user saves one, after ready.
app.commandLine.appendSwitch("password-store", "basic");
app.setPath(
  "userData",
  process.env.UAO_DESKTOP_USER_DATA ??
    join(app.getPath("appData"), "uao-desktop"),
);
installUaoCleartext();
const officeRuntime = prepareUaoOffice();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  initLogger();
  log.info("[uao] single-instance lock unavailable - quitting");
  app.quit();
} else {
  void startUaoDesktop().catch((err: unknown) => {
    initLogger();
    log.error("[uao] fatal startup error", err);
    app.quit();
  });
}

async function startUaoDesktop(): Promise<void> {
  initLogger();
  log.info("[uao] starting UAO desktop standalone shell");

  app.on("second-instance", () => {
    if (uaoWindow !== null) {
      if (uaoWindow.isMinimized()) {
        uaoWindow.restore();
      }
      uaoWindow.focus();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    if (serverInstance !== null) {
      void serverInstance.close();
      serverInstance = null;
    }
  });

  await app.whenReady();

  const staticDir = join(app.getAppPath(), "dist", "renderer-uao");
  const port = Number(process.env.UAO_DESKTOP_PORT ?? "5183");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("UAO_DESKTOP_PORT must be a valid local port.");
  }
  const backendTarget = resolveBackendTarget();
  serverInstance = await startUaoServer({
    staticDir,
    backendPort: backendTarget.port,
    backendHost: backendTarget.host,
    upstream: backendTarget.upstream,
    // Stable origin keeps the embedded UAO UI and worktab preferences across restarts.
    // The app's single-instance lock prevents two desktop shells sharing this port.
    port,
  });

  hardenUaoSession(serverInstance.origin);

  uaoWindow = new BrowserWindow({
    title: "UAO — Ultimate Agent OS",
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0d",
    webPreferences: {
      preload: join(__dirname, "uao-office-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      // Agent OS and OpenMuse are guests. will-attach-webview admits only their origins.
      webviewTag: true,
    },
  });

  attachUaoOffice(uaoWindow, serverInstance.origin, officeRuntime);
  attachAgentOs(uaoWindow, serverInstance.origin, app.getPath("userData"));
  attachCloudroom(uaoWindow, serverInstance.origin, app.getPath("userData"));
  attachOpenMuse(uaoWindow, serverInstance.origin, app.getPath("userData"));

  uaoWindow.on("closed", () => {
    uaoWindow = null;
  });

  uaoWindow.once("ready-to-show", () => {
    uaoWindow?.show();
  });

  uaoWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safelyOpenExternal(url);
    return { action: "deny" };
  });

  installNavigationGuard(uaoWindow.webContents);

  uaoWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      log.error("[uao] did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );

  const startUrl = `${serverInstance.origin}/desktop/uao.html`;
  log.info("[uao] loading UAO standalone renderer", { startUrl });
  await uaoWindow.loadURL(startUrl);
}
