import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_DEFAULT_HERMES_URL,
  AGENT_OS_DEFAULT_OMNIROUTE_URL,
  agentOsEmbedUrl,
  type AgentOsPublicConfig,
} from "@traycer-clients/shared/agent-os-endpoints";
import { UaoAgentOsPane } from "../uao-agent-os-pane";

const EMBED = agentOsEmbedUrl(AGENT_OS_DEFAULT_BASE_URL);

function config(): AgentOsPublicConfig {
  return {
    baseUrl: AGENT_OS_DEFAULT_BASE_URL,
    hermesUrl: AGENT_OS_DEFAULT_HERMES_URL,
    omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
    localSupervisor: false,
    embedUrl: EMBED,
    tokens: { "agent-os": false, hermes: false, omniroute: false },
  };
}

function renderPane(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UaoAgentOsPane endpointsChrome={null} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "uaoAgentOs");
});

describe("Agent OS page", () => {
  it("shows the URL and the error when the remote page cannot be reached", async () => {
    window.uaoAgentOs = {
      getConfig: () => Promise.resolve(config()),
      setConfig: () => Promise.resolve(config()),
      setToken: () => Promise.resolve({ ok: true }),
      probe: () =>
        Promise.resolve({ ok: false, error: "connect ECONNREFUSED" }),
    };
    renderPane();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("connect ECONNREFUSED");
    expect(alert.textContent).toContain(EMBED);
    expect(document.querySelector("webview")).toBeNull();
    screen.getByRole("button", { name: "Endpoints" }).click();
    const base = await screen.findByLabelText("Agent OS");
    if (!(base instanceof HTMLInputElement)) {
      throw new Error("Agent OS field is not an input.");
    }
    expect(base.value).toBe(AGENT_OS_DEFAULT_BASE_URL);
    const hermes = screen.getByLabelText("Hermes");
    const omniroute = screen.getByLabelText("Omniroute");
    if (
      !(hermes instanceof HTMLInputElement) ||
      !(omniroute instanceof HTMLInputElement)
    ) {
      throw new Error("Endpoint fields are not inputs.");
    }
    expect(hermes.value).toBe(AGENT_OS_DEFAULT_HERMES_URL);
    expect(omniroute.value).toBe(AGENT_OS_DEFAULT_OMNIROUTE_URL);
  });

  it("loads the Tailscale embed URL in the Agent OS guest", async () => {
    window.uaoAgentOs = {
      getConfig: () => Promise.resolve(config()),
      setConfig: () => Promise.resolve(config()),
      setToken: () => Promise.resolve({ ok: true }),
      probe: () => Promise.resolve({ ok: true, error: null }),
    };
    renderPane();
    await waitFor(() => {
      const guest = document.querySelector("iframe");
      expect(guest?.getAttribute("src")).toBe(EMBED);
      expect(guest?.getAttribute("title")).toBe("Agent OS");
    });
    expect(document.querySelector("webview")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
