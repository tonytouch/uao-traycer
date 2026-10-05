/**
 * Electron renders Agent OS and OpenMuse in a `<webview>` guest so the shell
 * Content-Security-Policy does not apply to the remote page. Android's
 * WebView and a phone browser have no such tag: the unknown element never
 * fires `did-stop-loading`, and the waiting overlay stays up on a blank pane.
 * Those shells use an iframe. Android still needs the main-source cleartext
 * network security config, because the iframe URL is `http://100.x`.
 */

interface GuestLoadFailure {
  readonly code: number;
  readonly description: string;
  readonly mainFrame: boolean;
}

export interface RemoteHttpGuestMount {
  readonly container: HTMLElement;
  readonly url: string;
  readonly title: string;
  readonly partition: string;
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}

export function isElectronWebviewElement(probe: object): boolean {
  return "getWebContentsId" in probe;
}

export function electronWebviewAvailable(doc: Document): boolean {
  return isElectronWebviewElement(doc.createElement("webview"));
}

function readGuestLoadFailure(event: Event): GuestLoadFailure | null {
  if (!("errorCode" in event) || typeof event.errorCode !== "number") {
    return null;
  }
  if (
    !("errorDescription" in event) ||
    typeof event.errorDescription !== "string"
  ) {
    return null;
  }
  const mainFrame = !("isMainFrame" in event) || event.isMainFrame !== false;
  return {
    code: event.errorCode,
    description: event.errorDescription,
    mainFrame,
  };
}

function mountElectronWebview(input: RemoteHttpGuestMount): () => void {
  const webview = input.container.ownerDocument.createElement("webview");
  webview.setAttribute("partition", input.partition);
  webview.setAttribute("aria-label", input.title);
  webview.setAttribute("title", input.title);
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.border = "none";
  let disposed = false;
  const onFail = (event: Event) => {
    const failure = readGuestLoadFailure(event);
    if (failure === null || !failure.mainFrame || failure.code === -3) return;
    if (disposed) return;
    input.onError(`${failure.description} (${String(failure.code)})`);
  };
  const onStop = () => {
    if (!disposed) input.onReady();
  };
  webview.addEventListener("did-fail-load", onFail);
  webview.addEventListener("did-stop-loading", onStop);
  webview.setAttribute("src", input.url);
  input.container.appendChild(webview);
  return () => {
    disposed = true;
    webview.removeEventListener("did-fail-load", onFail);
    webview.removeEventListener("did-stop-loading", onStop);
    webview.remove();
  };
}

function mountIframe(input: RemoteHttpGuestMount): () => void {
  const iframe = input.container.ownerDocument.createElement("iframe");
  iframe.setAttribute("title", input.title);
  iframe.setAttribute("aria-label", input.title);
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "none";
  let disposed = false;
  const onLoad = () => {
    if (!disposed) input.onReady();
  };
  const onError = () => {
    if (!disposed) input.onError("The page could not load.");
  };
  iframe.addEventListener("load", onLoad);
  iframe.addEventListener("error", onError);
  iframe.setAttribute("src", input.url);
  input.container.appendChild(iframe);
  return () => {
    disposed = true;
    iframe.removeEventListener("load", onLoad);
    iframe.removeEventListener("error", onError);
    iframe.remove();
  };
}

export function mountRemoteHttpGuest(input: RemoteHttpGuestMount): () => void {
  const doc = input.container.ownerDocument;
  if (electronWebviewAvailable(doc)) return mountElectronWebview(input);
  return mountIframe(input);
}
