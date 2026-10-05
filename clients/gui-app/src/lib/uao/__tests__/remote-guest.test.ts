import { afterEach, describe, expect, it } from "vitest";
import { AGENT_OS_WEBVIEW_PARTITION } from "@traycer-clients/shared/agent-os-endpoints";
import {
  electronWebviewAvailable,
  isElectronWebviewElement,
  mountRemoteHttpGuest,
} from "../remote-guest";

const URL = "http://100.90.167.20:5050/?embed=1#overview";

afterEach(() => {
  document.body.replaceChildren();
});

describe("remote http guest", () => {
  it("uses an iframe when the document has no Electron webview", () => {
    expect(electronWebviewAvailable(document)).toBe(false);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const cleanup = mountRemoteHttpGuest({
      container,
      url: URL,
      title: "Agent OS",
      partition: AGENT_OS_WEBVIEW_PARTITION,
      onReady: () => undefined,
      onError: () => undefined,
    });
    const guest = container.querySelector("iframe");
    expect(guest?.getAttribute("src")).toBe(URL);
    expect(guest?.getAttribute("title")).toBe("Agent OS");
    expect(container.querySelector("webview")).toBeNull();
    cleanup();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("treats a guest with getWebContentsId as an Electron webview", () => {
    expect(isElectronWebviewElement({ getWebContentsId: () => 1 })).toBe(true);
    expect(isElectronWebviewElement(document.createElement("div"))).toBe(false);
  });
});
