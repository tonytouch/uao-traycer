import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { config, DESKTOP_APP_NAME, isDevBuild } from "../config";
import { initLogger, log } from "./app/logger";
import { resolveDesktopRuntimeIdentity } from "./dev-desktop-runtime";
import { devDesktopSlotForEnvironment } from "./host/dev-desktop-slot";
import { devRendererUrlFromEnv } from "../ipc-contracts/dev-renderer-origin";
import {
  hardenDefaultSession,
  installNavigationGuard,
  safelyOpenExternal,
} from "./app/security";
import { RESOLUTION_TEST_USER_DATA_DIR_ENV } from "./windows/resolution-test-env";

const isUaoDevMode =
  isDevBuild &&
  (process.env.TRAYCER_DESKTOP_UAO_DEV === "1" ||
    process.argv.includes("--uao"));

let uaoWindow: BrowserWindow | null = null;

if (isUaoDevMode) {
  const slot = devDesktopSlotForEnvironment(config.environment, process.env);
  const appName = slot !== null ? `UAO Dev — ${slot}` : "UAO Dev";
  const userDataDirName = slot !== null ? `uao-dev-${slot}` : "uao-dev";
  app.setName(appName);
  app.setPath("userData", join(app.getPath("appData"), userDataDirName));
} else {
  // Electron keys both the single-instance lock and the entire userData directory
  // off the app name/userData path. Set identity BEFORE requesting the lock (and
  // before any userData access) so each build/run gets its own lock + Electron
  // runtime state. Production/staging/no-slot dev keep their stamped app name;
  // multi-run dev adds a slot suffix without changing `config.environment`.
  const runtimeIdentity = resolveDesktopRuntimeIdentity(
    DESKTOP_APP_NAME,
    config.environment,
    process.env,
  );
  app.setName(runtimeIdentity.appName);
  if (runtimeIdentity.userDataDirName !== null) {
    app.setPath(
      "userData",
      join(app.getPath("appData"), runtimeIdentity.userDataDirName),
    );
  }
}

const resolutionTestUserDataDir =
  process.env[RESOLUTION_TEST_USER_DATA_DIR_ENV] ?? null;
if (
  resolutionTestUserDataDir !== null &&
  resolutionTestUserDataDir.length > 0
) {
  app.setPath("userData", resolutionTestUserDataDir);
}

// Single-instance lock applies uniformly so deep links and dock relaunches
// target the primary process. With the dev userData split above, a
// `make dev-desktop` shell and a packaged Traycer.app hold separate locks.
//
// In UAO mode, Traycer's full phased startup is bypassed. In normal Traycer mode,
// all boot logic lives in the phased orchestrator (`startup/desktop-startup`):
// pre-ready → on-ready → window (auth-first) → deferred. The desktop performs
// no host/service registration at boot - the CLI owns the host lifecycle
// and the renderer provisions it post-sign-in via the `host ensure` IPC.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  initLogger();
  log.info(
    isUaoDevMode
      ? "[uao] single-instance lock unavailable - quitting"
      : "[desktop] single-instance lock unavailable - quitting",
  );
  app.quit();
} else {
  void startDesktop(isUaoDevMode).catch((err: unknown) => {
    log.error(
      isUaoDevMode
        ? "[uao] fatal startup error"
        : "[desktop] fatal startup error",
      err,
    );
  });
}

async function startDesktop(uao: boolean): Promise<void> {
  if (uao) {
    await runUaoStartup();
    return;
  }
  const { runDesktopStartup } = await import("./startup/desktop-startup");
  await runDesktopStartup();
}

async function runUaoStartup(): Promise<void> {
  initLogger();
  log.info("[uao] starting UAO standalone dev desktop");

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

  await app.whenReady();
  hardenDefaultSession();

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

  const devUrl = devRendererUrlFromEnv(process.env);
  const uaoUrl = `${devUrl}/uao.html`;
  log.info("[uao] loading UAO standalone renderer", { uaoUrl });
  await uaoWindow.loadURL(uaoUrl);
}
