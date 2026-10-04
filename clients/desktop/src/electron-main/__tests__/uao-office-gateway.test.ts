import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureOfficeAi, GATEWAY_MARKER, gatewayMessages, gatewayModels,
  parseGatewayTurn, streamGateway, chatGateway,
} from "../../../../../integrations/genoffice/local-gateway";

const directories: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "office-gateway-"));
  directories.push(dir);
  const config = join(dir, "gateway.json");
  writeFileSync(config, JSON.stringify({ baseUrl: "http://127.0.0.1:8765/v1", model: "codex", token: "private-test-token" }));
  vi.stubEnv("UAO_OFFICE_GATEWAY_CONFIG", config);
  vi.stubEnv("LOCAL_GATEWAY_TOKEN", "private-test-token");
  return dir;
}
const config = { apiKey: GATEWAY_MARKER, model: "codex", baseUrl: "https://untrusted.invalid/v1" };
const tools = [{ name: "replace_text", description: "Replace text", inputSchema: { type: "object" } }];
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("Office local gateway", () => {
  it("migrates settings without exposing the token and respects later provider changes", () => {
    const dir = setup();
    configureOfficeAi(dir);
    const file = join(dir, "ai-settings.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("private-test-token");
    expect(JSON.parse(text)).toMatchObject({ provider: "custom", gskToolsEnabled: false,
      providers: { custom: { apiKey: GATEWAY_MARKER, model: "codex", baseUrl: "http://127.0.0.1:8765/v1" } } });
    const changed = { ...JSON.parse(text), provider: "codex" };
    writeFileSync(file, JSON.stringify(changed));
    configureOfficeAi(dir);
    expect(JSON.parse(readFileSync(file, "utf8")).provider).toBe("codex");
  });
  it("preserves tool results, call history and errors in the gateway transcript", () => {
    const messages = gatewayMessages("Edit the document", [
      { role: "assistant", text: "", toolCalls: [{ id: "one", name: "replace_text", input: { text: "new" } }] },
      { role: "tool", results: [{ id: "one", name: "replace_text", output: "No selection", isError: true }] },
    ], tools);
    expect(JSON.stringify(messages)).toContain("No selection");
    expect(JSON.stringify(messages)).toContain("isError");
    expect(JSON.stringify(messages)).toContain("replace_text");
  });
  it("rejects malformed or unknown tool calls before any execution", () => {
    expect(() => parseGatewayTurn('{"text":"","toolCalls":[{"name":"shell","input":{}}]}', tools)).toThrow("unknown");
    expect(() => parseGatewayTurn("I edited it", tools)).toThrow("invalid");
    expect(() => parseGatewayTurn('{"text":"","toolCalls":[{"name":"replace_text","input":"bad"}]}', tools)).toThrow("malformed");
  });
  it("delivers document tool calls and authenticates only to the main-process endpoint", async () => {
    setup();
    const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify({ text: "Updating", toolCalls: [{ name: "replace_text", input: { text: "new" } }] }) } }] }));
    vi.stubGlobal("fetch", fetch);
    const onDelta = vi.fn(); const onToolCall = vi.fn();
    await streamGateway(config, "Edit", [{ role: "user", text: "Change this" }], tools,
      { signal: new AbortController().signal, onDelta, onToolCall });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8765/v1/chat/completions", expect.objectContaining({
      redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer private-test-token" }),
    }));
    expect(onDelta).toHaveBeenCalledWith("Updating");
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: "replace_text", input: { text: "new" } }));
  });
  it("surfaces authentication failures without echoing gateway response secrets", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-test-token", { status: 401 })));
    const reply = await chatGateway(config, "", "Hello", undefined);
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining("rejected its token") });
    expect(JSON.stringify(reply)).not.toContain("private-test-token");
  });
  it("propagates cancellation to the gateway so the CLI process is stopped", async () => {
    setup();
    const cancelled: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith("/cancel")) { cancelled.push(url); return Promise.resolve(Response.json({ cancelled: true }, { status: 202 })); }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    }));
    const controller = new AbortController(); const onDelta = vi.fn();
    const pending = streamGateway(config, "", [], [], { signal: controller.signal, onDelta, onToolCall: vi.fn() });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(onDelta).not.toHaveBeenCalled();
    const fetchMock = vi.mocked(fetch);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { request_id: string };
    await vi.waitFor(() => expect(cancelled).toEqual([`http://127.0.0.1:8765/v1/requests/${sent.request_id}/cancel`]));
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer private-test-token" }) });
  });
  it("retries one malformed model reply with the rejection reason, then succeeds", async () => {
    setup();
    const answers = ["I edited it for you", JSON.stringify({ text: "Done", toolCalls: [{ name: "replace_text", input: { text: "new" } }] })];
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ choices: [{ message: { content: answers.shift() } }] })));
    vi.stubGlobal("fetch", fetch);
    const onToolCall = vi.fn();
    await streamGateway(config, "Edit", [{ role: "user", text: "Change" }], tools, { signal: new AbortController().signal, onDelta: vi.fn(), onToolCall });
    expect(fetch).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(fetch.mock.calls[1]![1].body)) as { messages: { role: string; content: string }[] };
    expect(retry.messages.slice(-2)).toEqual([
      { role: "assistant", content: "I edited it for you" },
      { role: "user", content: expect.stringContaining("previous reply was rejected") },
    ]);
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });
  it("gives up after a single retry and executes nothing", async () => {
    setup();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ choices: [{ message: { content: "not json" } }] })));
    vi.stubGlobal("fetch", fetch);
    const onToolCall = vi.fn();
    await expect(streamGateway(config, "", [{ role: "user", text: "x" }], tools,
      { signal: new AbortController().signal, onDelta: vi.fn(), onToolCall })).rejects.toThrow("failed twice");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onToolCall).not.toHaveBeenCalled();
  });
  it("does not retry transport or authentication failures", async () => {
    setup();
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await expect(chatGateway(config, "", "Hello", undefined)).resolves.toMatchObject({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("starts with defaults when stored AI settings are corrupt and keeps the bad file", () => {
    const dir = setup();
    const file = join(dir, "ai-settings.json");
    writeFileSync(file, "{not json");
    const warning = configureOfficeAi(dir);
    expect(warning).toContain("reset");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ provider: "custom" });
    expect(readdirSync(dir).some(name => name.startsWith("ai-settings.json.corrupt-"))).toBe(true);
  });
  it("disables only AI when the gateway configuration is malformed", async () => {
    const dir = setup();
    writeFileSync(join(dir, "gateway.json"), "{broken");
    expect(configureOfficeAi(dir)).toContain("Office AI is unavailable");
    // The gateway stays selected so the panel reports the real problem on use.
    expect(JSON.parse(readFileSync(join(dir, "ai-settings.json"), "utf8"))).toMatchObject({ provider: "custom" });
    expect(existsSync(join(dir, "uao-office-gateway-v1"))).toBe(false);
    await expect(gatewayModels()).resolves.toEqual({ models: [], defaultModel: "codex" });
    await expect(chatGateway(config, "", "Hi", undefined)).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
  });
  it("reports unsupported image input before making a network request", async () => {
    setup();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(streamGateway(config, "", [{ role: "user", text: "Read this", images: [{ mime: "image/png", base64: "AA==" }] }], [],
      { signal: new AbortController().signal, onDelta: vi.fn(), onToolCall: vi.fn() })).rejects.toThrow("supports text only");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("loads the live model catalog with main-process credentials", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: "codex" }, { id: "freebuff" }] })));
    await expect(gatewayModels()).resolves.toEqual({ models: ["codex", "freebuff"], defaultModel: "codex" });
  });
});
