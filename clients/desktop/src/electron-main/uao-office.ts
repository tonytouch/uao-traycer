import { app, ipcMain, type BrowserWindow, type Rectangle, type IpcMainInvokeEvent, type IpcMainEvent } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { isOfficeKind, type OfficeTab } from "../ipc-contracts/uao-office";
import { log } from "./app/logger";

interface OfficeHost {
  readonly list: () => readonly OfficeTab[];
  readonly create: (kind: string) => Promise<void>;
  readonly browse: () => Promise<void>;
  readonly activate: (id: string) => void;
  readonly close: (id: string) => Promise<void>;
  readonly closeAll: () => Promise<boolean>;
  readonly setViewport: (bounds: Rectangle | null) => void;
}
interface OfficeModule {
  readonly prepareOfficeRuntime: () => void;
  readonly createOfficeHost: (window: BrowserWindow, resources: string) => OfficeHost;
}
const resources = app.isPackaged
  ? process.resourcesPath
  : join(app.getAppPath(), "resources", "genoffice");
const modulePath = join(resources, "genoffice-host.cjs");

/** Register GenOffice's secure schemes before Electron is ready. */
export function prepareUaoOffice(): OfficeModule | null {
  if (!existsSync(modulePath)) return null;
  const require = createRequire(join(app.getAppPath(), "package.json"));
  const value: unknown = require(modulePath);
  if (typeof value !== "object" || value === null ||
    !("prepareOfficeRuntime" in value) || typeof value.prepareOfficeRuntime !== "function" ||
    !("createOfficeHost" in value) || typeof value.createOfficeHost !== "function") {
    throw new Error("Invalid bundled GenOffice runtime.");
  }
  const runtime = value as OfficeModule;
  runtime.prepareOfficeRuntime();
  return runtime;
}

export function attachUaoOffice(window: BrowserWindow, origin: string, runtime: OfficeModule | null): void {
  // A failure inside Office (for example broken AI settings) must not stop UAO
  // itself from opening; Office requests then report the reason.
  let host: OfficeHost | null = null;
  let startupError: string | null = null;
  try { host = runtime?.createOfficeHost(window, resources) ?? null; }
  catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    log.error("[uao] Office failed to start", error);
  }
  const authorized = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; }
    catch { return false; }
  };
  const getHost = (event: IpcMainInvokeEvent) => {
    if (!authorized(event)) throw new Error("Office request refused.");
    if (!host) throw new Error(startupError ? `Office failed to start: ${startupError}` : "GenOffice is missing from this desktop build.");
    return host;
  };
  ipcMain.handle("uao-office:list", event => getHost(event).list());
  ipcMain.handle("uao-office:create", (event, kind: unknown) => {
    if (!isOfficeKind(kind)) throw new Error("Unknown document type.");
    return getHost(event).create(kind);
  });
  ipcMain.handle("uao-office:browse", event => getHost(event).browse());
  ipcMain.handle("uao-office:activate", (event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid document.");
    getHost(event).activate(id);
  });
  ipcMain.handle("uao-office:close", (event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid document.");
    return getHost(event).close(id);
  });
  ipcMain.on("uao-office:viewport", (event, bounds: unknown) => {
    if (!authorized(event) || !host) return;
    if (bounds === null) { host.setViewport(null); return; }
    if (typeof bounds !== "object" ||
      !("x" in bounds) || typeof bounds.x !== "number" ||
      !("y" in bounds) || typeof bounds.y !== "number" ||
      !("width" in bounds) || typeof bounds.width !== "number" ||
      !("height" in bounds) || typeof bounds.height !== "number" ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return;
    const content = window.getContentBounds();
    const x = Math.min(content.width, Math.max(0, Math.round(bounds.x)));
    const y = Math.min(content.height, Math.max(0, Math.round(bounds.y)));
    host.setViewport({ x, y,
      width: Math.max(0, Math.min(content.width - x, Math.round(bounds.width))),
      height: Math.max(0, Math.min(content.height - y, Math.round(bounds.height))) });
  });
  let closeAllowed = false;
  let closing = false;
  window.on("close", event => {
    if (!host || closeAllowed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void host.closeAll().then(allowed => {
      closeAllowed = allowed;
      if (allowed) window.close();
    }).catch((error: unknown) => {
      log.error("[uao] office save/close check failed", error);
    }).finally(() => { closing = false; });
  });
}
