import { describe, expect, it } from "vitest";
import { AGENT_OS_DEFAULT_BASE_URL } from "@traycer-clients/shared/agent-os-endpoints";
import { CLOUDROOM_DEFAULT_BASE_URL } from "@traycer-clients/shared/cloudroom";
import { OPENMUSE_DEFAULT_WEB_URL } from "@traycer-clients/shared/openmuse";
import {
  createBrowserUaoApis,
  installBrowserUaoApis,
  type UaoBrowserStorage,
  type UaoBrowserWindow,
} from "../browser-remote-apis";

function memoryStorage(): UaoBrowserStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function unusedFetch(): typeof fetch {
  return () => Promise.reject(new Error("fetch was not expected"));
}

describe("browser UAO remote APIs", () => {
  it("stores endpoint URLs and reports a token as saved without returning it", async () => {
    const apis = createBrowserUaoApis(memoryStorage(), unusedFetch());
    const initial = await apis.agentOs.getConfig();
    expect(initial.baseUrl).toBe(AGENT_OS_DEFAULT_BASE_URL);
    expect(initial.embedUrl).toContain("http://100.90.167.20:5050");
    expect(initial.tokens["agent-os"]).toBe(false);

    await apis.agentOs.setConfig({
      ...initial,
      baseUrl: "http://100.90.167.21:5050",
    });
    const saved = await apis.agentOs.setToken("agent-os", "secret-token");
    expect(saved).toEqual({ ok: true });
    const next = await apis.agentOs.getConfig();
    expect(next.baseUrl).toBe("http://100.90.167.21:5050");
    expect(next.tokens["agent-os"]).toBe(true);
    expect(JSON.stringify(next)).not.toContain("secret-token");

    const cloudroom = await apis.cloudroom.getConfig();
    expect(cloudroom.baseUrl).toBe(CLOUDROOM_DEFAULT_BASE_URL);
    const openmuse = await apis.openmuse.getConfig();
    expect(openmuse.webUrl).toBe(OPENMUSE_DEFAULT_WEB_URL);
  });

  it("does not replace APIs the Electron preload already published", () => {
    const existing = {
      getConfig: () => Promise.reject(new Error("desktop")),
      setConfig: () => Promise.reject(new Error("desktop")),
      setToken: () => Promise.reject(new Error("desktop")),
      probe: () => Promise.reject(new Error("desktop")),
    };
    const target: UaoBrowserWindow = {
      localStorage: memoryStorage(),
      uaoAgentOs: existing,
      uaoCloudroom: {
        getConfig: () => Promise.reject(new Error("desktop")),
        setConfig: () => Promise.reject(new Error("desktop")),
        setToken: () => Promise.reject(new Error("desktop")),
        health: () => Promise.reject(new Error("desktop")),
        listSessions: () => Promise.reject(new Error("desktop")),
        createSession: () => Promise.reject(new Error("desktop")),
        events: () => Promise.reject(new Error("desktop")),
      },
      uaoOpenMuse: {
        getConfig: () => Promise.reject(new Error("desktop")),
        setConfig: () => Promise.reject(new Error("desktop")),
        health: () => Promise.reject(new Error("desktop")),
      },
    };
    installBrowserUaoApis(target);
    expect(target.uaoAgentOs).toBe(existing);
  });
});
