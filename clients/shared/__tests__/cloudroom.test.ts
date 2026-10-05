import { describe, expect, it } from "vitest";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  CloudroomClientError,
  cloudroomBaseUrlFromStored,
  createCloudroomClient,
  createCloudroomEnvironment,
  createCloudroomRequestId,
  mergeCloudroomEvents,
  parseCloudroomHealth,
  parseCloudroomPublicConfig,
  resolveCloudroomBaseUrl,
} from "../cloudroom";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudRoom client", () => {
  it("reports ready, not-ready, and a refused token", async () => {
    const ready = createCloudroomClient({
      baseUrl: "http://100.90.167.20:9840/",
      token: "tok",
      fetchImpl: () => Promise.resolve(jsonResponse(200, { ready: true })),
    });
    expect(await ready.ready()).toEqual({ ready: true });

    const notReady = createCloudroomClient({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () => Promise.resolve(jsonResponse(503, { ready: false })),
    });
    expect(await notReady.ready()).toEqual({ ready: false });

    const denied = createCloudroomClient({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(401, { error: "unauthorized", code: "unauthorized" }),
        ),
    });
    await expect(denied.ready()).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
  });

  it("turns a network failure into an unreachable error", async () => {
    const client = createCloudroomClient({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "",
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(client.ready()).rejects.toMatchObject({
      kind: "unreachable",
      message: expect.stringContaining("Can't reach CloudRoom"),
    });
  });

  it("sends the bearer token and reads sessions, creates, and events", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createCloudroomClient({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "s3cret",
      fetchImpl: (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/v1/sessions") && init?.method === "POST") {
          return Promise.resolve(
            jsonResponse(202, { session_id: "cr_demo", receipt: "accepted" }),
          );
        }
        if (url.endsWith("/v1/sessions")) {
          return Promise.resolve(
            jsonResponse(200, {
              total: 1,
              sessions: [
                {
                  session_id: "cr_demo",
                  harness: "codex",
                  state: "idle",
                  model: "gpt",
                  last_activity_ms: 5,
                },
                { harness: "codex" },
                { session_id: "../etc/passwd" },
              ],
            }),
          );
        }
        if (url.includes("/events")) {
          return Promise.resolve(
            jsonResponse(200, {
              events: [
                { sequence: 2, kind: "text_delta", data: { text: "Hello" } },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, {}));
      },
    });

    expect(await client.listSessions()).toEqual([
      {
        sessionId: "cr_demo",
        harness: "codex",
        state: "idle",
        model: "gpt",
        lastActivityMs: 5,
      },
    ]);
    expect(
      await client.createSession({
        requestId: "uao-1",
        harness: "codex",
        workspace: null,
      }),
    ).toEqual({ sessionId: "cr_demo" });
    expect(await client.events("cr_demo", 0)).toEqual([
      { sequence: 2, kind: "text_delta", text: "Hello" },
    ]);

    const listCall = calls.find(
      (call) =>
        call.url.endsWith("/v1/sessions") && call.init?.method !== "POST",
    );
    expect(listCall?.init?.headers).toMatchObject({
      authorization: "Bearer s3cret",
    });
    const createCall = calls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      request_id: "uao-1",
      harness: "codex",
    });
    expect(JSON.stringify(calls)).not.toContain("s3cret-in-body");
  });

  it("reads a bare event array and refuses a session id that is not cr_", async () => {
    const client = createCloudroomClient({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(200, [{ sequence: 1, kind: "text_delta", data: "Hi" }]),
        ),
    });
    expect(await client.events("cr_demo", 0)).toEqual([
      { sequence: 1, kind: "text_delta", text: "Hi" },
    ]);
    await expect(client.events("../ready", 0)).rejects.toBeInstanceOf(
      CloudroomClientError,
    );
  });
});

describe("CloudRoom environment", () => {
  it("does not call the network when no URL is set", async () => {
    let calls = 0;
    const environment = createCloudroomEnvironment({
      baseUrl: "   ",
      token: "tok",
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(new Error("should not fetch"));
      },
      requestId: () => "uao-1",
    });
    expect(await environment.health()).toMatchObject({
      status: "unconfigured",
    });
    expect(await environment.listSessions()).toEqual({
      ok: false,
      error: "CloudRoom is not configured.",
      code: null,
      sessionId: null,
    });
    expect(
      await environment.createSession({
        harness: "codex",
        prompt: "hi",
        workspace: "",
      }),
    ).toEqual({
      ok: false,
      error: "CloudRoom is not configured.",
      code: null,
      sessionId: null,
    });
    expect(calls).toBe(0);
  });

  it("reports unreachable and unauthorized without throwing", async () => {
    const down = createCloudroomEnvironment({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      requestId: () => "uao-1",
    });
    expect(await down.health()).toMatchObject({
      status: "unreachable",
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      message: expect.stringContaining("Can't reach CloudRoom"),
    });

    const denied = createCloudroomEnvironment({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(401, { error: "nope", code: "unauthorized" }),
        ),
      requestId: () => "uao-1",
    });
    expect(await denied.health()).toMatchObject({
      status: "unauthorized",
      message: expect.stringContaining("CLOUDROOM_TOKEN"),
    });

    const notReady = createCloudroomEnvironment({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () => Promise.resolve(jsonResponse(503, { ready: false })),
      requestId: () => "uao-1",
    });
    expect(await notReady.health()).toMatchObject({ status: "not-ready" });
  });

  it("rejects a harness CloudRoom cannot run", async () => {
    let calls = 0;
    const environment = createCloudroomEnvironment({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(jsonResponse(200, {}));
      },
      requestId: () => "uao-1",
    });
    const result = await environment.createSession({
      harness: "kimchi",
      prompt: "",
      workspace: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Codex");
    expect(calls).toBe(0);
  });

  it("keeps the session id when the first prompt fails", async () => {
    const environment = createCloudroomEnvironment({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      token: "tok",
      fetchImpl: (url) => {
        if (url.includes("/prompts")) {
          return Promise.resolve(
            jsonResponse(409, { error: "busy", code: "storage_blocked" }),
          );
        }
        return Promise.resolve(
          jsonResponse(202, { session_id: "cr_demo", receipt: "accepted" }),
        );
      },
      requestId: () => "uao-1",
    });
    expect(
      await environment.createSession({
        harness: "codex",
        prompt: "hello",
        workspace: "",
      }),
    ).toEqual({
      ok: false,
      error: "busy",
      code: "storage_blocked",
      sessionId: "cr_demo",
    });
  });
});

describe("CloudRoom settings", () => {
  it("keeps an origin and a blank URL, and drops a token field", () => {
    expect(
      resolveCloudroomBaseUrl({ baseUrl: "  http://100.90.167.20:9840/x  " }),
    ).toBe(CLOUDROOM_DEFAULT_BASE_URL);
    expect(resolveCloudroomBaseUrl({ baseUrl: "  " })).toBe("");
    expect(() =>
      resolveCloudroomBaseUrl({ baseUrl: "javascript:alert(1)" }),
    ).toThrow(/http/);
    expect(cloudroomBaseUrlFromStored({})).toBe(CLOUDROOM_DEFAULT_BASE_URL);
    expect(cloudroomBaseUrlFromStored({ baseUrl: "" })).toBe("");
    expect(
      parseCloudroomPublicConfig({
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        tokenSaved: true,
        token: "do-not-keep",
      }),
    ).toEqual({ baseUrl: CLOUDROOM_DEFAULT_BASE_URL, tokenSaved: true });
    expect(
      parseCloudroomHealth({
        status: "unauthorized",
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        message: "refused",
        token: "do-not-keep",
      }),
    ).toEqual({
      status: "unauthorized",
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      message: "refused",
    });
  });

  it("builds a request id Core will accept", () => {
    const id = createCloudroomRequestId("123e4567-e89b-12d3-a456-426614174000");
    expect(id).toBe("uao-123e4567-e89b-12d3-a456-426614174000");
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("appends new event text once", () => {
    const first = mergeCloudroomEvents(0, "", [
      { sequence: 2, kind: "text_delta", text: "Hello" },
      { sequence: 1, kind: "text_delta", text: "Hi " },
    ]);
    expect(first).toEqual({ cursor: 2, text: "Hi Hello" });
    expect(
      mergeCloudroomEvents(first.cursor, first.text, [
        { sequence: 2, kind: "text_delta", text: "Hello" },
        { sequence: 3, kind: "text_delta", text: "!" },
      ]),
    ).toEqual({ cursor: 3, text: "Hi Hello!" });
  });
});
