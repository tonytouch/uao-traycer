import {
  ipcMain,
  safeStorage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import {
  effectiveAgentOsBaseUrl,
  isAgentOsTokenService,
  probeAgentOs,
  resolveAgentOsEndpoints,
} from "@traycer-clients/shared/agent-os-endpoints";
import { UaoAgentOsChannel } from "../ipc-contracts/agent-os";
import {
  readAgentOsEndpoints,
  readAgentOsPublicConfig,
  writeAgentOsEndpoints,
  writeAgentOsToken,
  type AgentOsSecretStore,
} from "./agent-os-endpoint-store";
import { installAgentOsWebviewGuard } from "./agent-os-webview";

function electronSecrets(): AgentOsSecretStore {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (cipher) => safeStorage.decryptString(cipher),
  };
}

/**
 * Settings and the remote-page probe for the UAO window.
 * safeStorage is touched only when a token is saved or would be read, never at startup:
 * a locked keyring must not block the window the way Chromium's cookie key once did.
 */
export function attachAgentOs(
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
    if (!authorized(event)) throw new Error("Agent OS request refused.");
  };
  const readBase = (): string =>
    effectiveAgentOsBaseUrl(readAgentOsEndpoints(directory));

  installAgentOsWebviewGuard(window.webContents, readBase);

  ipcMain.handle(UaoAgentOsChannel.getConfig, (event) => {
    assertAuthorized(event);
    return readAgentOsPublicConfig(directory);
  });
  ipcMain.handle(UaoAgentOsChannel.setConfig, (event, draft: unknown) => {
    assertAuthorized(event);
    const next = resolveAgentOsEndpoints(
      readAgentOsEndpoints(directory),
      draft,
    );
    writeAgentOsEndpoints(directory, next);
    return readAgentOsPublicConfig(directory);
  });
  ipcMain.handle(
    UaoAgentOsChannel.setToken,
    (event, service: unknown, token: unknown) => {
      assertAuthorized(event);
      if (!isAgentOsTokenService(service)) throw new Error("Unknown token.");
      if (typeof token !== "string") throw new Error("Invalid token.");
      return writeAgentOsToken(directory, electronSecrets(), service, token);
    },
  );
  ipcMain.handle(UaoAgentOsChannel.probe, async (event) => {
    assertAuthorized(event);
    return probeAgentOs(readBase(), fetch);
  });
}
