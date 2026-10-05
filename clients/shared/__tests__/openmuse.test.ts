import { describe, expect, it, vi } from "vitest";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
  OPENMUSE_PARTITION,
  OPENMUSE_RETIRED_API_URL,
  checkOpenMuseHealth,
  decideOpenMuseAttach,
  migrateOpenMuseApiUrl,
  openMuseFromStored,
  openMusePermissionAllowed,
  parseOpenMuseHealth,
  parseOpenMusePublicConfig,
  resolveOpenMuseEndpoints,
  type OpenMuseProbe,
} from "../openmuse";

function probe(
  handler: (url: string) => { readonly ok: boolean; readonly body: unknown },
): OpenMuseProbe {
  return (url) =>
    Promise.resolve({
      ok: handler(url).ok,
      status: handler(url).ok ? 200 : 503,
      json: () => Promise.resolve(handler(url).body),
    });
}

describe("OpenMuse endpoints", () => {
  it("keeps a blank web URL and migrates the retired Hermes port", () => {
    expect(
      openMuseFromStored({
        openmuseUrl: "  ",
        openmuseApiUrl: OPENMUSE_RETIRED_API_URL,
      }),
    ).toEqual({ webUrl: "", apiUrl: OPENMUSE_DEFAULT_API_URL });
    expect(openMuseFromStored(null)).toEqual({
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
    });
    expect(migrateOpenMuseApiUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(
      resolveOpenMuseEndpoints({
        webUrl: " http://100.90.167.20:8081/ignored ",
        apiUrl: "",
      }),
    ).toEqual({ webUrl: OPENMUSE_DEFAULT_WEB_URL, apiUrl: "" });
    expect(() =>
      resolveOpenMuseEndpoints({ webUrl: "not a url", apiUrl: "" }),
    ).toThrow(/http/);
    expect(
      parseOpenMusePublicConfig({
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
        apiUrl: OPENMUSE_DEFAULT_API_URL,
      }),
    ).toEqual({
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
    });
  });

  it("admits a guest only on the OpenMuse partition and web origin", () => {
    expect(
      decideOpenMuseAttach({
        src: `${OPENMUSE_DEFAULT_WEB_URL}/`,
        partition: OPENMUSE_PARTITION,
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
      }),
    ).toBe("allow");
    expect(
      decideOpenMuseAttach({
        src: OPENMUSE_DEFAULT_WEB_URL,
        partition: "persist:uao-agent-os",
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
      }),
    ).toBe("deny");
    expect(
      decideOpenMuseAttach({
        src: "http://evil.example/",
        partition: OPENMUSE_PARTITION,
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
      }),
    ).toBe("deny");
    expect(
      decideOpenMuseAttach({
        src: OPENMUSE_DEFAULT_WEB_URL,
        partition: OPENMUSE_PARTITION,
        webUrl: "",
      }),
    ).toBe("deny");
    expect(
      decideOpenMuseAttach({
        src: "javascript:alert(1)",
        partition: OPENMUSE_PARTITION,
        webUrl: OPENMUSE_DEFAULT_WEB_URL,
      }),
    ).toBe("deny");
  });
});

describe("openMusePermissionAllowed", () => {
  const web = OPENMUSE_DEFAULT_WEB_URL;

  it("allows clipboard only for the configured web origin", () => {
    expect(openMusePermissionAllowed("clipboard-read", `${web}/`, web)).toBe(
      true,
    );
    expect(
      openMusePermissionAllowed(
        "clipboard-sanitized-write",
        web,
        `${web}/index.html`,
      ),
    ).toBe(true);
    expect(
      openMusePermissionAllowed("clipboard-read", "http://evil.test", web),
    ).toBe(false);
  });

  it("denies media and every other permission", () => {
    expect(openMusePermissionAllowed("media", web, web)).toBe(false);
    expect(openMusePermissionAllowed("display-capture", web, web)).toBe(false);
    expect(openMusePermissionAllowed("clipboard-read", web, "")).toBe(false);
    expect(openMusePermissionAllowed("geolocation", web, web)).toBe(false);
  });
});

describe("checkOpenMuseHealth", () => {
  it("does not fetch when the web URL is empty", async () => {
    const fetchImpl = vi.fn<OpenMuseProbe>();
    const health = await checkOpenMuseHealth({
      webUrl: " ",
      apiUrl: "http://host:8787",
      fetchImpl,
    });
    expect(health.status).toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseOpenMuseHealth(health)).toEqual(health);
  });

  it("reports unreachable when the web app does not answer", async () => {
    const fetchImpl = vi.fn<OpenMuseProbe>(() =>
      Promise.reject(new Error("offline")),
    );
    const health = await checkOpenMuseHealth({
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
      fetchImpl,
    });
    expect(health.status).toBe("unreachable");
    if (health.status === "unreachable") {
      expect(health.message).toContain(OPENMUSE_DEFAULT_WEB_URL);
      expect(health.message).toContain("offline");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stays degraded when the API is empty or does not report ok", async () => {
    const webOnly = probe(() => ({ ok: true, body: " " }));
    const emptyApi = await checkOpenMuseHealth({
      webUrl: `${OPENMUSE_DEFAULT_WEB_URL}/`,
      apiUrl: "",
      fetchImpl: webOnly,
    });
    expect(emptyApi.status).toBe("degraded");
    if (emptyApi.status === "degraded") {
      expect(emptyApi.webUrl).toBe(OPENMUSE_DEFAULT_WEB_URL);
    }

    const fetchImpl = probe((url) =>
      url.endsWith("/api/health")
        ? { ok: true, body: { ok: false } }
        : { ok: true, body: null },
    );
    const degraded = await checkOpenMuseHealth({
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: "http://100.90.167.20:8791",
      fetchImpl,
    });
    expect(degraded.status).toBe("degraded");
  });

  it("is ready when the web app and the API both answer", async () => {
    const fetchImpl = probe((url) =>
      url.endsWith("/api/health")
        ? { ok: true, body: { ok: true } }
        : { ok: true, body: null },
    );
    const health = await checkOpenMuseHealth({
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: "http://100.90.167.20:8791/",
      fetchImpl,
    });
    expect(health).toMatchObject({
      status: "ready",
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: "http://100.90.167.20:8791",
    });
  });
});
