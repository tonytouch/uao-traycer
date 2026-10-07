import { describe, expect, it } from "vitest";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_DEFAULT_ENDPOINTS,
  AGENT_OS_DEFAULT_HERMES_URL,
  AGENT_OS_DEFAULT_OMNIROUTE_URL,
  AGENT_OS_LOCAL_BASE_URL,
  AGENT_OS_WEBVIEW_PARTITION,
  agentOsEmbedUrl,
  decideAgentOsAttach,
  effectiveAgentOsBaseUrl,
  isAllowedAgentOsGuestUrl,
  isTailscaleCgnatHost,
  parseAgentOsPublicConfig,
  parseHttpOrigin,
  probeAgentOs,
  resolveAgentOsEndpoints,
  tailscaleCleartextOrigins,
} from "../agent-os-endpoints";

describe("Agent OS endpoints", () => {
  it("embeds the Tailscale Agent OS with the remote page's embed flag", () => {
    expect(agentOsEmbedUrl(AGENT_OS_DEFAULT_BASE_URL)).toBe(
      "http://100.90.167.20:5050/?embed=1#overview",
    );
    expect(effectiveAgentOsBaseUrl(AGENT_OS_DEFAULT_ENDPOINTS)).toBe(
      AGENT_OS_DEFAULT_BASE_URL,
    );
    expect(
      effectiveAgentOsBaseUrl({
        ...AGENT_OS_DEFAULT_ENDPOINTS,
        localSupervisor: true,
      }),
    ).toBe(AGENT_OS_LOCAL_BASE_URL);
    expect(agentOsEmbedUrl(AGENT_OS_LOCAL_BASE_URL)).toBe(
      "http://127.0.0.1:5050/?embed=1#overview",
    );
  });

  it("keeps only an http(s) origin", () => {
    expect(parseHttpOrigin("  http://100.90.167.20:5050/ignored?x=1#y  ")).toBe(
      "http://100.90.167.20:5050",
    );
    expect(parseHttpOrigin("https://agent.example")).toBe(
      "https://agent.example",
    );
    expect(parseHttpOrigin("javascript:alert(1)")).toBeNull();
    expect(parseHttpOrigin("file:///tmp/x")).toBeNull();
    expect(parseHttpOrigin("http://user:secret@100.90.167.20:5050")).toBeNull();
    expect(parseHttpOrigin("")).toBeNull();
  });

  it("recognizes Tailscale CGNAT and ignores other addresses", () => {
    expect(isTailscaleCgnatHost("100.90.167.20")).toBe(true);
    expect(isTailscaleCgnatHost("100.64.0.1")).toBe(true);
    expect(isTailscaleCgnatHost("100.127.255.255")).toBe(true);
    expect(isTailscaleCgnatHost("100.63.0.1")).toBe(false);
    expect(isTailscaleCgnatHost("100.128.0.1")).toBe(false);
    expect(isTailscaleCgnatHost("10.0.0.5")).toBe(false);
    expect(isTailscaleCgnatHost("127.0.0.1")).toBe(false);
    expect(
      tailscaleCleartextOrigins([
        AGENT_OS_DEFAULT_BASE_URL,
        AGENT_OS_DEFAULT_HERMES_URL,
        AGENT_OS_DEFAULT_OMNIROUTE_URL,
        "https://100.90.167.20:5050",
        "http://192.168.1.20:5050",
        "http://100.90.167.20:5050",
      ]),
    ).toBe(
      "http://100.90.167.20:5050,http://100.90.167.20:8787,http://100.90.167.20:20128",
    );
  });

  it("allows a guest only on the configured origin and partition", () => {
    const embed = agentOsEmbedUrl(AGENT_OS_DEFAULT_BASE_URL);
    expect(
      decideAgentOsAttach({
        src: embed,
        partition: AGENT_OS_WEBVIEW_PARTITION,
        allowedBaseUrl: AGENT_OS_DEFAULT_BASE_URL,
      }),
    ).toBe("allow");
    expect(
      isAllowedAgentOsGuestUrl(
        `${AGENT_OS_DEFAULT_BASE_URL}/healthz`,
        AGENT_OS_DEFAULT_BASE_URL,
      ),
    ).toBe(true);
    expect(
      decideAgentOsAttach({
        src: embed,
        partition: "persist:other",
        allowedBaseUrl: AGENT_OS_DEFAULT_BASE_URL,
      }),
    ).toBe("deny");
    expect(
      decideAgentOsAttach({
        src: "http://evil.example/",
        partition: AGENT_OS_WEBVIEW_PARTITION,
        allowedBaseUrl: AGENT_OS_DEFAULT_BASE_URL,
      }),
    ).toBe("deny");
    expect(
      decideAgentOsAttach({
        src: "javascript:alert(1)",
        partition: AGENT_OS_WEBVIEW_PARTITION,
        allowedBaseUrl: AGENT_OS_DEFAULT_BASE_URL,
      }),
    ).toBe("deny");
    expect(
      decideAgentOsAttach({
        src: "file:///etc/passwd",
        partition: AGENT_OS_WEBVIEW_PARTITION,
        allowedBaseUrl: AGENT_OS_DEFAULT_BASE_URL,
      }),
    ).toBe("deny");
  });

  it("rejects a draft that is not an http address and blanks back to the current value", () => {
    expect(
      resolveAgentOsEndpoints(AGENT_OS_DEFAULT_ENDPOINTS, {
        baseUrl: "",
        hermesUrl: "https://hermes.example:8787/unused",
        omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
        localSupervisor: false,
      }),
    ).toEqual({
      ...AGENT_OS_DEFAULT_ENDPOINTS,
      hermesUrl: "https://hermes.example:8787",
    });
    expect(() =>
      resolveAgentOsEndpoints(AGENT_OS_DEFAULT_ENDPOINTS, {
        baseUrl: "not a url",
        hermesUrl: AGENT_OS_DEFAULT_HERMES_URL,
        omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
        localSupervisor: false,
      }),
    ).toThrow(/http/);
  });

  it("recomputes the embed URL from the saved origins", () => {
    const parsed = parseAgentOsPublicConfig({
      baseUrl: AGENT_OS_DEFAULT_BASE_URL,
      hermesUrl: AGENT_OS_DEFAULT_HERMES_URL,
      omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
      localSupervisor: false,
      embedUrl: "http://evil.example/steal",
      tokens: { "agent-os": true, hermes: false },
    });
    expect(parsed.embedUrl).toBe("http://100.90.167.20:5050/?embed=1#overview");
    expect(parsed.tokens).toEqual({
      "agent-os": true,
      hermes: false,
      omniroute: false,
    });
  });

  it("reports HTTP failures with a status and network failures with the thrown message", async () => {
    const down = await probeAgentOs(AGENT_OS_DEFAULT_BASE_URL, () =>
      Promise.resolve(new Response("no", { status: 502 })),
    );
    expect(down).toEqual({ ok: false, error: "HTTP 502" });

    const refused = await probeAgentOs(AGENT_OS_DEFAULT_BASE_URL, () =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    expect(refused).toEqual({ ok: false, error: "connect ECONNREFUSED" });

    const up = await probeAgentOs(AGENT_OS_DEFAULT_BASE_URL, () =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );
    expect(up).toEqual({ ok: true, error: null });
  });
});
