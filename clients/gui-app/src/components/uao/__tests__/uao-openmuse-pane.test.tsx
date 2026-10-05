import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
  OPENMUSE_PARTITION,
  type OpenMuseEndpointConfig,
  type OpenMuseHealth,
  type UaoOpenMuseApi,
} from "@traycer-clients/shared/openmuse";
import { UaoOpenMusePane } from "../uao-openmuse-pane";

const READY: OpenMuseHealth = {
  status: "ready",
  webUrl: OPENMUSE_DEFAULT_WEB_URL,
  apiUrl: OPENMUSE_DEFAULT_API_URL,
  message: "OpenMuse is reachable.",
};

function config(webUrl: string, apiUrl: string): OpenMuseEndpointConfig {
  return { webUrl, apiUrl };
}

function renderPane(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UaoOpenMusePane />
    </QueryClientProvider>,
  );
}

function install(api: UaoOpenMuseApi): void {
  window.uaoOpenMuse = api;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "uaoOpenMuse");
});

describe("OpenMuse page", () => {
  it("shows the URL and the error when the web app cannot be reached", async () => {
    const health: OpenMuseHealth = {
      status: "unreachable",
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
      message: `Unable to reach OpenMuse at ${OPENMUSE_DEFAULT_WEB_URL}. offline`,
    };
    install({
      getConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      setConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      health: () => Promise.resolve(health),
    });
    renderPane();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("offline");
    expect(alert.textContent).toContain(OPENMUSE_DEFAULT_WEB_URL);
    expect(document.querySelector("webview")).toBeNull();
    screen.getByRole("button", { name: "Retry" });
    screen.getByRole("button", { name: "Endpoints" }).click();
    const web = await screen.findByLabelText("OpenMuse web");
    const api = screen.getByLabelText("OpenMuse API");
    if (
      !(web instanceof HTMLInputElement) ||
      !(api instanceof HTMLInputElement)
    ) {
      throw new Error("Endpoint fields are not inputs.");
    }
    expect(web.value).toBe(OPENMUSE_DEFAULT_WEB_URL);
    expect(api.value).toBe(OPENMUSE_DEFAULT_API_URL);
    expect(document.querySelector("input[type='password']")).toBeNull();
  });

  it("loads the Tailscale web URL in the OpenMuse guest", async () => {
    install({
      getConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      setConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      health: () => Promise.resolve(READY),
    });
    renderPane();
    await waitFor(() => {
      const guest = document.querySelector("webview");
      expect(guest?.getAttribute("src")).toBe(OPENMUSE_DEFAULT_WEB_URL);
      expect(guest?.getAttribute("partition")).toBe(OPENMUSE_PARTITION);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still embeds the page when the API is degraded", async () => {
    const health: OpenMuseHealth = {
      status: "degraded",
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
      message: `The web app is up, but ${OPENMUSE_DEFAULT_API_URL}/api/health did not report ok. The page still loads. That URL has to match EXPO_PUBLIC_API_URL.`,
    };
    install({
      getConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      setConfig: () =>
        Promise.resolve(
          config(OPENMUSE_DEFAULT_WEB_URL, OPENMUSE_DEFAULT_API_URL),
        ),
      health: () => Promise.resolve(health),
    });
    renderPane();
    expect(await screen.findByText(/did not report ok/)).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector("webview")?.getAttribute("src")).toBe(
        OPENMUSE_DEFAULT_WEB_URL,
      );
    });
  });

  it("shows endpoints and no guest when the web URL is blank", async () => {
    install({
      getConfig: () => Promise.resolve(config("", OPENMUSE_DEFAULT_API_URL)),
      setConfig: () => Promise.resolve(config("", OPENMUSE_DEFAULT_API_URL)),
      health: () =>
        Promise.resolve({
          status: "unconfigured",
          message: "Set an OpenMuse web URL to show this page.",
        }),
    });
    renderPane();
    expect(
      await screen.findByText("Set an OpenMuse web URL to show this page."),
    ).toBeTruthy();
    expect(document.querySelector("webview")).toBeNull();
    const web = screen.getByLabelText("OpenMuse web");
    if (!(web instanceof HTMLInputElement)) {
      throw new Error("OpenMuse web field is not an input.");
    }
    expect(web.value).toBe("");
    expect(document.querySelector("input[type='password']")).toBeNull();
  });
});
