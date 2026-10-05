import {
  session,
  type Event,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import {
  AGENT_OS_WEBVIEW_PARTITION,
  decideAgentOsAttach,
  isAllowedAgentOsGuestUrl,
} from "@traycer-clients/shared/agent-os-endpoints";
import { log } from "./app/logger";
import { installPermissionHandlers, safelyOpenExternal } from "./app/security";

/**
 * The renderer chooses `<webview webpreferences="...">`. Drop every key this
 * function does not set so a new Electron preference cannot arrive enabled.
 */
export function hardenAgentOsGuestPreferences(
  webPreferences: WebPreferences,
): void {
  const prefs: WebPreferences = webPreferences;
  for (const key of Object.keys(prefs)) {
    delete prefs[key as keyof WebPreferences];
  }
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.sandbox = true;
  prefs.contextIsolation = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.webviewTag = false;
  prefs.partition = AGENT_OS_WEBVIEW_PARTITION;
}

let guestSession: Session | null = null;

function ensureGuestSession(): void {
  if (guestSession !== null) return;
  guestSession = session.fromPartition(AGENT_OS_WEBVIEW_PARTITION);
  installPermissionHandlers(guestSession);
}

/**
 * Fail-closed admission for the one Agent OS guest. The shell's browser-tile
 * grant path stays unused: this window only ever loads the configured origin.
 */
export function installAgentOsWebviewGuard(
  host: WebContents,
  readAllowedBaseUrl: () => string,
): void {
  ensureGuestSession();
  host.on(
    "will-attach-webview",
    (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => {
      const decision = decideAgentOsAttach({
        src: params.src ?? "",
        partition: params.partition ?? "",
        allowedBaseUrl: readAllowedBaseUrl(),
      });
      if (decision === "deny") {
        event.preventDefault();
        log.warn("[agent-os] webview attach denied");
        return;
      }
      hardenAgentOsGuestPreferences(webPreferences);
    },
  );
  host.on("did-attach-webview", (_event: Event, guest: WebContents) => {
    const blockForeign = (event: Event, url: string): void => {
      if (isAllowedAgentOsGuestUrl(url, readAllowedBaseUrl())) return;
      event.preventDefault();
      log.warn("[agent-os] webview navigation denied");
    };
    guest.on("will-navigate", blockForeign);
    guest.on("will-redirect", (event, url) => {
      blockForeign(event, url);
    });
    guest.setWindowOpenHandler(({ url }) => {
      void safelyOpenExternal(url);
      return { action: "deny" };
    });
  });
}
