import {
  ipcMain,
  safeStorage,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import {
  createCloudroomEnvironment,
  createCloudroomRequestId,
  resolveCloudroomBaseUrl,
  type CloudroomCallResult,
  type CloudroomCreateInput,
  type CloudroomEnvironment,
  type CloudroomEvent,
  type CloudroomHealth,
  type CloudroomSessionSummary,
} from "@traycer-clients/shared/cloudroom";
import { UaoCloudroomChannel } from "../ipc-contracts/cloudroom";
import {
  readAgentOsToken,
  writeAgentOsToken,
  type AgentOsSecretStore,
} from "./agent-os-endpoint-store";
import {
  readCloudroomBaseUrl,
  readCloudroomPublicConfig,
  writeCloudroomBaseUrl,
} from "./cloudroom-store";

function electronSecrets(): AgentOsSecretStore {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (cipher) => safeStorage.decryptString(cipher),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}

function readCreateInput(value: unknown): CloudroomCreateInput | null {
  if (!isRecord(value) || typeof value.harness !== "string") return null;
  return {
    harness: value.harness,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    workspace: typeof value.workspace === "string" ? value.workspace : "",
  };
}

function refused<T>(): CloudroomCallResult<T> {
  return {
    ok: false,
    error:
      "CloudRoom runs Codex, Claude Code, Pi, and Cursor. Pick one of those.",
    code: null,
    sessionId: null,
  };
}

/**
 * CloudRoom HTTP runs here so the bearer token never crosses into the renderer.
 * safeStorage is touched only when a token is saved or a request would send one.
 */
export function attachCloudroom(
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
    if (!authorized(event)) throw new Error("CloudRoom request refused.");
  };
  const environment = (): CloudroomEnvironment => {
    const token =
      readAgentOsToken(directory, electronSecrets(), "cloudroom") ?? "";
    return createCloudroomEnvironment({
      baseUrl: readCloudroomBaseUrl(directory),
      token,
      fetchImpl: undefined,
      requestId: () => createCloudroomRequestId(globalThis.crypto.randomUUID()),
    });
  };

  ipcMain.handle(UaoCloudroomChannel.getConfig, (event) => {
    assertAuthorized(event);
    return readCloudroomPublicConfig(directory);
  });
  ipcMain.handle(UaoCloudroomChannel.setConfig, (event, draft: unknown) => {
    assertAuthorized(event);
    writeCloudroomBaseUrl(directory, resolveCloudroomBaseUrl(draft));
    return readCloudroomPublicConfig(directory);
  });
  ipcMain.handle(UaoCloudroomChannel.setToken, (event, token: unknown) => {
    assertAuthorized(event);
    if (typeof token !== "string") throw new Error("Invalid token.");
    return writeAgentOsToken(directory, electronSecrets(), "cloudroom", token);
  });
  ipcMain.handle(UaoCloudroomChannel.health, async (event) => {
    assertAuthorized(event);
    try {
      return await environment().health();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "CloudRoom is unreachable.";
      const failed: CloudroomHealth = {
        status: "unreachable",
        baseUrl: readCloudroomBaseUrl(directory),
        message,
      };
      return failed;
    }
  });
  ipcMain.handle(
    UaoCloudroomChannel.listSessions,
    async (event): Promise<CloudroomCallResult<CloudroomSessionSummary[]>> => {
      assertAuthorized(event);
      try {
        return await environment().listSessions();
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "CloudRoom request failed.",
          code: null,
          sessionId: null,
        };
      }
    },
  );
  ipcMain.handle(
    UaoCloudroomChannel.createSession,
    async (event, input: unknown) => {
      assertAuthorized(event);
      const create = readCreateInput(input);
      if (create === null) return refused();
      try {
        return await environment().createSession(create);
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "CloudRoom request failed.",
          code: null,
          sessionId: null,
        };
      }
    },
  );
  ipcMain.handle(
    UaoCloudroomChannel.events,
    async (
      event,
      sessionId: unknown,
      after: unknown,
    ): Promise<CloudroomCallResult<CloudroomEvent[]>> => {
      assertAuthorized(event);
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        return {
          ok: false,
          error: "Missing CloudRoom session.",
          code: null,
          sessionId: null,
        };
      }
      try {
        return await environment().events(sessionId, readCursor(after));
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "CloudRoom request failed.",
          code: null,
          sessionId: null,
        };
      }
    },
  );
}
