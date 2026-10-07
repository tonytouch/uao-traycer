import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  checkOpenMuseHealth,
  resolveOpenMuseEndpoints,
  type OpenMuseHealth,
} from "@traycer-clients/shared/openmuse";
import { UaoOpenMuseChannel } from "../ipc-contracts/openmuse";
import {
  readOpenMuseEndpoints,
  writeOpenMuseEndpoints,
} from "./agent-os-endpoint-store";
import {
  installOpenMusePartitionPolicy,
  installOpenMuseWebviewGuard,
} from "./openmuse-webview";

/**
 * Settings and the remote-page health check for the UAO window.
 * The OpenMuse access key is not stored and is not read here. Live mode asks
 * for it inside the page.
 */
export function attachOpenMuse(
  window: BrowserWindow,
  shellOrigin: string,
  directory: string,
): void {
  const authorized = (event: IpcMainInvokeEvent): boolean => {
    if (event.sender !== window.webContents) return false;
    if (event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      return new URL(event.senderFrame.url).origin === shellOrigin;
    } catch {
      return false;
    }
  };
  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorized(event)) throw new Error("OpenMuse request refused.");
  };
  const readWeb = (): string => readOpenMuseEndpoints(directory).webUrl;

  installOpenMuseWebviewGuard(window.webContents, readWeb);
  installOpenMusePartitionPolicy(readWeb());

  ipcMain.handle(UaoOpenMuseChannel.getConfig, (event) => {
    assertAuthorized(event);
    return readOpenMuseEndpoints(directory);
  });
  ipcMain.handle(UaoOpenMuseChannel.setConfig, (event, draft: unknown) => {
    assertAuthorized(event);
    const next = resolveOpenMuseEndpoints(draft);
    writeOpenMuseEndpoints(directory, next);
    installOpenMusePartitionPolicy(next.webUrl);
    return readOpenMuseEndpoints(directory);
  });
  ipcMain.handle(UaoOpenMuseChannel.health, async (event) => {
    assertAuthorized(event);
    try {
      const endpoints = readOpenMuseEndpoints(directory);
      installOpenMusePartitionPolicy(endpoints.webUrl);
      return await checkOpenMuseHealth({
        webUrl: endpoints.webUrl,
        apiUrl: endpoints.apiUrl,
        fetchImpl: undefined,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OpenMuse is unreachable.";
      const failed: OpenMuseHealth = {
        status: "unreachable",
        message,
        webUrl: "",
        apiUrl: "",
      };
      return failed;
    }
  });
}
