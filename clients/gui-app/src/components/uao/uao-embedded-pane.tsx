import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { attachDraftPersistence } from "@/lib/uao/draft-persistence";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import {
  DEFAULT_PANE_ID,
  getFeatureOwnerId,
  isValidNavPaneId,
  isNativeUaoPane,
  WORKSPACE_PANE_ID,
} from "./uao-nav-registry";

interface UaoEmbeddedPaneProps {
  readonly activePaneId: string;
  readonly onChildNavigate: (paneId: string) => void;
  readonly chatOnly?: boolean;
}

// Keep the normal UAO shell's header, palette, providers, drawers and toasts.
export const UAO_CHROME_CSS = `
  .sidebar, .sidebar-scrim, .mobile-menu-trigger, .embed-nav-toggle { display: none !important; }
  .app-body, .app-main { width: 100% !important; }
  .app-main { flex: 1 1 auto !important; }
`;

function getSafeWebRoute(lastId: string): string {
  if (
    !isNativeUaoPane(lastId) &&
    lastId !== "chat" &&
    isValidNavPaneId(lastId)
  ) {
    return lastId;
  }
  return DEFAULT_PANE_ID;
}

export function UaoEmbeddedPane({
  activePaneId,
  onChildNavigate,
  chatOnly = false,
}: UaoEmbeddedPaneProps) {
  const uiQuery = useQuery(uaoQueryOptions.builtUi());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [initialFeatureId] = useState(
    () => getSafeWebRoute(activePaneId),
  );
  const lastFeatureId = useRef<string>(initialFeatureId);
  const initialSrc = `/uao-api/?desktop-frame=1#/${chatOnly ? "chat" : initialFeatureId}`;
  const cleanupRef = useRef<(() => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);

  // replace avoids adding a second joint-history entry for a sidebar click.
  useEffect(() => {
    if (chatOnly || isNativeUaoPane(activePaneId) || activePaneId === "chat")
      return;
    lastFeatureId.current = activePaneId;
    const child = iframeRef.current?.contentWindow;
    if (ready && child && child.location.hash !== `#/${activePaneId}`) {
      child.location.replace(
        new URL(`#/${activePaneId}`, child.location.href).href,
      );
    }
  }, [activePaneId, ready, chatOnly]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const handleLoad = useCallback(() => {
    cleanupRef.current?.();
    const child = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!child || !doc?.getElementById("root")) {
      setFrameError("The backend did not load the UAO interface.");
      return;
    }
    const style = doc.createElement("style");
    style.textContent = UAO_CHROME_CSS;
    doc.head.appendChild(style);

    const childHashId = child.location.hash.replace(/^#\/?/, "");
    if (chatOnly) {
      child.location.replace(new URL("#/chat", child.location.href).href);
    } else if (childHashId === "chat") {
      const safe = getSafeWebRoute(lastFeatureId.current);
      child.location.replace(new URL(`#/${safe}`, child.location.href).href);
      onChildNavigate(WORKSPACE_PANE_ID);
    } else {
      const hash = `#/${lastFeatureId.current}`;
      if (child.location.hash !== hash) {
        child.location.replace(new URL(hash, child.location.href).href);
      }
    }

    let redirectedRoute: string | null = null;
    const restoreRoute = (id: string) => {
      if (child.location.hash === `#/${id}`) return;
      redirectedRoute = id;
      child.location.replace(new URL(`#/${id}`, child.location.href).href);
    };
    const onHashChange = () => {
      const id = child.location.hash.replace(/^#\/?/, "");
      if (id === redirectedRoute) {
        redirectedRoute = null;
        return;
      }
      if (chatOnly) {
        if (id !== "chat" && isValidNavPaneId(id)) {
          restoreRoute("chat");
          onChildNavigate(id);
        }
        return;
      }
      if (id === "chat") {
        const safe = getSafeWebRoute(lastFeatureId.current);
        restoreRoute(safe);
        onChildNavigate(WORKSPACE_PANE_ID);
        return;
      }
      if (!isNativeUaoPane(id) && isValidNavPaneId(id)) {
        if (getFeatureOwnerId(id) === getFeatureOwnerId(lastFeatureId.current)) {
          lastFeatureId.current = id;
        } else {
          restoreRoute(lastFeatureId.current);
        }
        onChildNavigate(id);
      }
    };
    // Restore cross-feature hashes before UAO's router reads them, so the
    // current pane never unmounts when its header opens another desktop tab.
    child.addEventListener("hashchange", onHashChange, true);
    const detachDrafts = attachDraftPersistence(doc, {
      scope: () =>
        chatOnly ? "chat" : getFeatureOwnerId(lastFeatureId.current),
    });
    const observer = new MutationObserver(() => {
      if (doc.querySelector(".app-shell")) {
        setReady(true);
        clearTimeout(timeout);
        observer.disconnect();
      }
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      setFrameError(
        "UAO's frontend did not start. Check its built UI and retry.",
      );
    }, 15000);
    observer.observe(doc.getElementById("root") ?? doc, {
      childList: true,
      subtree: true,
    });
    if (doc.querySelector(".app-shell")) {
      setReady(true);
      clearTimeout(timeout);
      observer.disconnect();
    }
    cleanupRef.current = () => {
      clearTimeout(timeout);
      observer.disconnect();
      child.removeEventListener("hashchange", onHashChange, true);
      detachDrafts();
    };
  }, [chatOnly, onChildNavigate]);

  const error = uiQuery.isError ? uiQuery.error.message : frameError;
  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      {/* Trusted local UAO application, not an untrusted preview. Same-origin scripts
          are required for its API, hash routing and chrome integration; this iframe
          sandbox cannot isolate it from the shell. Electron remains sandboxed. */}
      {uiQuery.isSuccess ? (
        <iframe
          key={attempt}
          ref={iframeRef}
          title={
            chatOnly
              ? "UAO Built-in Dedicated Chat"
              : "Ultimate Agent OS Built Interface"
          }
          src={initialSrc}
          onLoad={handleLoad}
          onError={() => setFrameError("The UAO interface could not load.")}
          className="h-full w-full border-0 bg-background"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
          allow="clipboard-read; clipboard-write; microphone"
        />
      ) : null}
      {error ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6"
        >
          <AlertCircle className="size-6 text-destructive" />
          <h2 className="font-heading text-ui-md font-bold">
            UAO interface unavailable
          </h2>
          <p className="max-w-lg text-center text-ui-xs text-muted-foreground">
            {error}
          </p>
          <p className="max-w-lg text-center text-ui-xs text-muted-foreground">
            Keep the UAO backend and its built frontend running on port 5050.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={uiQuery.isFetching}
            onClick={() => {
              cleanupRef.current?.();
              setReady(false);
              setFrameError(null);
              setAttempt((value) => value + 1);
              void uiQuery.refetch();
            }}
          >
            Retry Connection
          </Button>
        </div>
      ) : null}
      {!error && !ready && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6"
        >
          <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" />
          <p className="text-ui-sm text-muted-foreground">
            Loading UAO interface…
          </p>
        </div>
      )}
    </div>
  );
}
