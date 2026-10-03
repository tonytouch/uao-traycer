import { app, BrowserWindow, session } from "electron";
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

let uaoWindow: BrowserWindow | null = null;
let serverInstance: UaoServerInstance | null = null;

function hardenUaoSession(serverOrigin: string): void {
  const defaultSession = session.defaultSession;
  installPermissionHandlers(defaultSession);
  clampSessionTls(defaultSession);

  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    if (isUaoProxyDocument(details.url, serverOrigin)) {
      callback({ responseHeaders: headers });
      return;
    }
    headers["Content-Security-Policy"] = [UAO_CONTENT_SECURITY_POLICY];
    callback({ responseHeaders: headers });
  });
}

app.setName("UAO");
app.setPath("userData", join(app.getPath("appData"), "uao-desktop"));

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

  app.on("before-quit", () => {
    if (serverInstance !== null) {
      void serverInstance.close();
      serverInstance = null;
    }
  });

  await app.whenReady();

  const staticDir = join(app.getAppPath(), "dist", "renderer-uao");
  serverInstance = await startUaoServer({
    staticDir,
    backendPort: 5050,
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

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
