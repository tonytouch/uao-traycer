import { app, BrowserWindow, session } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Remote backend, e.g. a Mac reaching the Linux box over Tailscale. Env wins;
 * otherwise `<userData>/backend.json` ({"host": "...", "port": 5050}).
 */
function resolveBackendTarget(): {
  host?: string | undefined;
  port: number;
  jarvisUrl?: string | undefined;
} {
  let host = process.env.UAO_BACKEND_HOST;
  let port = Number(process.env.UAO_BACKEND_PORT ?? "5050");
  let jarvisUrl = process.env.UAO_JARVIS_URL;
  if (host === undefined) {
    try {
      const file = JSON.parse(
        readFileSync(join(app.getPath("userData"), "backend.json"), "utf8"),
      ) as { host?: unknown; port?: unknown; jarvisUrl?: unknown };
      if (typeof file.host === "string" && file.host !== "") host = file.host;
      if (typeof file.port === "number") port = file.port;
      if (jarvisUrl === undefined && typeof file.jarvisUrl === "string")
        jarvisUrl = file.jarvisUrl;
    } catch {
      // No config: use the local backend.
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UAO backend port must be a valid port.");
  }
  if (jarvisUrl !== undefined && jarvisUrl !== "") {
    const parsed = new URL(jarvisUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("UAO Jarvis URL must be https.");
    }
    return { host, port, jarvisUrl: parsed.href };
  }
  return { host, port };
}

let uaoWindow: BrowserWindow | null = null;
let serverInstance: UaoServerInstance | null = null;

function hardenUaoSession(serverOrigin: string): void {
  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession);
  clampSessionTls(defaultSession);

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    if (isUaoProxyDocument(details.url, serverOrigin) ||
      details.url.startsWith("genoffice-app:") || details.url.startsWith("genoffice-docx-media:") ||
      details.url.startsWith("html-preview:") || details.url.startsWith("html-asset:")) {
      callback({ responseHeaders: headers });
      return;
    }
    headers["Content-Security-Policy"] = [UAO_CONTENT_SECURITY_POLICY];
    callback({ responseHeaders: headers });
  });
}

app.setName("UAO");
// UAO keeps no secrets in the OS keyring. Chromium otherwise asks the desktop
// keyring for its cookie key at startup and blocks every window behind that
// prompt when the keyring is locked, missing or being set up.
app.commandLine.appendSwitch("password-store", "basic");
app.setPath("userData", process.env.UAO_DESKTOP_USER_DATA ?? join(app.getPath("appData"), "uao-desktop"));
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
    jarvisUrl: backendTarget.jarvisUrl,
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
    },
  });

  attachUaoOffice(uaoWindow, serverInstance.origin, officeRuntime);

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
