import {
  session,
  type Event,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import {
  OPENMUSE_PARTITION,
  decideOpenMuseAttach,
  isAllowedOpenMuseGuestUrl,
  openMusePermissionAllowed,
} from "@traycer-clients/shared/openmuse";
import { log } from "./app/logger";
import { safelyOpenExternal } from "./app/security";

/**
 * The renderer chooses `<webview webpreferences="...">`. Drop every key this
 * function does not set so a new Electron preference cannot arrive enabled.
 */
export function hardenOpenMuseGuestPreferences(
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
  prefs.partition = OPENMUSE_PARTITION;
}

let guestSession: Session | null = null;

/** Clipboard for the configured web origin only. Microphone, camera, and capture stay denied. */
export function installOpenMusePartitionPolicy(webUrl: string): void {
  const sess = session.fromPartition(OPENMUSE_PARTITION);
  guestSession = sess;
  const allow = (permission: string, requestingUrl: string): boolean =>
    openMusePermissionAllowed(permission, requestingUrl, webUrl);
  sess.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(allow(permission, details.requestingUrl));
    },
  );
  sess.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    allow(permission, requestingOrigin),
  );
  sess.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
}

function ensureGuestSession(webUrl: string): void {
  if (guestSession !== null) return;
  installOpenMusePartitionPolicy(webUrl);
}

/**
 * Fail-closed admission for the OpenMuse guest. The Agent OS guard ignores
 * this partition; this one ignores every other partition.
 */
export function installOpenMuseWebviewGuard(
  host: WebContents,
  readWebUrl: () => string,
): void {
  ensureGuestSession(readWebUrl());
  host.on(
    "will-attach-webview",
    (
      event: Event,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => {
      const partition = params.partition ?? "";
      if (partition !== OPENMUSE_PARTITION) return;
      const decision = decideOpenMuseAttach({
        src: params.src ?? "",
        partition,
        webUrl: readWebUrl(),
      });
      if (decision === "deny") {
        event.preventDefault();
        log.warn("[openmuse] webview attach denied");
        return;
      }
      hardenOpenMuseGuestPreferences(webPreferences);
    },
  );
  host.on("did-attach-webview", (_event: Event, guest: WebContents) => {
    if (guest.session !== session.fromPartition(OPENMUSE_PARTITION)) return;
    const blockForeign = (event: Event, url: string): void => {
      if (isAllowedOpenMuseGuestUrl(url, readWebUrl())) return;
      event.preventDefault();
      log.warn("[openmuse] webview navigation denied");
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
