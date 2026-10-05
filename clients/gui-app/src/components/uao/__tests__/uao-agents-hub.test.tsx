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
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  type UaoCloudroomApi,
} from "@traycer-clients/shared/cloudroom";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
  type UaoOpenMuseApi,
} from "@traycer-clients/shared/openmuse";
import { UAO_AGENTS_TAB_STORAGE_KEY } from "../uao-agents-tabs";
import { UaoAgentsHub } from "../uao-agents-hub";

const EMBED = agentOsEmbedUrl(AGENT_OS_DEFAULT_BASE_URL);

function agentOsConfig(): AgentOsPublicConfig {
  return {
    baseUrl: AGENT_OS_DEFAULT_BASE_URL,
    hermesUrl: AGENT_OS_DEFAULT_HERMES_URL,
    omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
    localSupervisor: false,
    embedUrl: EMBED,
    tokens: { "agent-os": false, hermes: false, omniroute: false },
  };
}

function installRemoteApis(openmuse: UaoOpenMuseApi): void {
  window.uaoAgentOs = {
    getConfig: () => Promise.resolve(agentOsConfig()),
    setConfig: () => Promise.resolve(agentOsConfig()),
    setToken: () => Promise.resolve({ ok: true }),
    probe: () => Promise.resolve({ ok: false, error: "connect ECONNREFUSED" }),
  };
  const cloudroom: UaoCloudroomApi = {
    getConfig: () =>
      Promise.resolve({
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        tokenSaved: false,
      }),
    setConfig: () =>
      Promise.resolve({
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        tokenSaved: false,
      }),
    setToken: () => Promise.resolve({ ok: true }),
    health: () =>
      Promise.resolve({
        status: "ready",
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        message: `Connected to CloudRoom at ${CLOUDROOM_DEFAULT_BASE_URL}.`,
      }),
    listSessions: () => Promise.resolve({ ok: true, value: [] }),
    createSession: () =>
      Promise.resolve({ ok: true, value: { sessionId: "cr_unused" } }),
    events: () => Promise.resolve({ ok: true, value: [] }),
  };
  window.uaoCloudroom = cloudroom;
  window.uaoOpenMuse = openmuse;
}

function readyOpenMuse(): UaoOpenMuseApi {
  return {
    getConfig: () =>
      Promise.resolve({
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
        apiUrl: OPENMUSE_DEFAULT_API_URL,
      }),
    setConfig: () =>
      Promise.resolve({
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
        apiUrl: OPENMUSE_DEFAULT_API_URL,
      }),
    health: () =>
      Promise.resolve({
        status: "ready",
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
        apiUrl: OPENMUSE_DEFAULT_API_URL,
        message: "OpenMuse is reachable.",
      }),
  };
}

function renderHub(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UaoAgentsHub />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(UAO_AGENTS_TAB_STORAGE_KEY);
  Reflect.deleteProperty(window, "uaoAgentOs");
  Reflect.deleteProperty(window, "uaoCloudroom");
  Reflect.deleteProperty(window, "uaoOpenMuse");
});

describe("Agents hub", () => {
  it("shows one Endpoints control for Agent OS, CloudRoom, and OpenMuse", async () => {
    installRemoteApis(readyOpenMuse());
    renderHub();

    expect(screen.getByRole("tablist", { name: "Agents" })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Agent OS" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "CloudRoom" })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      screen
        .getByRole("tab", { name: "OpenMuse" })
        .getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getAllByRole("button", { name: /endpoints/i })).toHaveLength(
      1,
    );

    screen.getByRole("button", { name: "Endpoints" }).click();
    const agentOs = await screen.findByRole("textbox", { name: "Agent OS" });
    if (!(agentOs instanceof HTMLInputElement)) {
      throw new Error("Agent OS field is not an input.");
    }
    expect(agentOs.value).toBe(AGENT_OS_DEFAULT_BASE_URL);

    screen.getByRole("tab", { name: "CloudRoom" }).click();
    expect(
      await screen.findByText(
        `Connected to CloudRoom at ${CLOUDROOM_DEFAULT_BASE_URL}.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Agent OS" })).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "CloudRoom" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    screen.getByRole("button", { name: "Endpoints" }).click();
    const cloudroom = await screen.findByRole("textbox", { name: "CloudRoom" });
    if (!(cloudroom instanceof HTMLInputElement)) {
      throw new Error("CloudRoom field is not an input.");
    }
    expect(cloudroom.value).toBe(CLOUDROOM_DEFAULT_BASE_URL);
    expect(screen.getAllByRole("button", { name: /endpoints/i })).toHaveLength(
      1,
    );

    screen.getByRole("tab", { name: "OpenMuse" }).click();
    await waitFor(() => {
      expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
        OPENMUSE_DEFAULT_WEB_URL,
      );
    });
    expect(window.localStorage.getItem(UAO_AGENTS_TAB_STORAGE_KEY)).toBe(
      "openmuse",
    );

    cleanup();
    renderHub();
    expect(
      screen
        .getByRole("tab", { name: "OpenMuse" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps OpenMuse endpoints available when the web URL is blank", async () => {
    window.localStorage.setItem(UAO_AGENTS_TAB_STORAGE_KEY, "openmuse");
    installRemoteApis({
      getConfig: () =>
        Promise.resolve({ webUrl: "", apiUrl: OPENMUSE_DEFAULT_API_URL }),
      setConfig: () =>
        Promise.resolve({ webUrl: "", apiUrl: OPENMUSE_DEFAULT_API_URL }),
      health: () =>
        Promise.resolve({
          status: "unconfigured",
          message: "Set an OpenMuse web URL to show this page.",
        }),
    });
    renderHub();
    expect(
      await screen.findByText("Set an OpenMuse web URL to show this page."),
    ).toBeTruthy();
    const web = screen.getByLabelText("OpenMuse web");
    if (!(web instanceof HTMLInputElement)) {
      throw new Error("OpenMuse web field is not an input.");
    }
    expect(web.value).toBe("");
    expect(
      (
        await screen.findByRole("button", { name: "Hide endpoints" })
      ).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getAllByRole("button", { name: /endpoints/i })).toHaveLength(
      1,
    );
    expect(document.querySelector("input[type='password']")).toBeNull();
  });
});
