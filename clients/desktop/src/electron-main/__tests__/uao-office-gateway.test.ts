import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  it("propagates cancellation and does not emit a completed turn", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    })));
    const controller = new AbortController(); const onDelta = vi.fn();
    const pending = streamGateway(config, "", [], [], { signal: controller.signal, onDelta, onToolCall: vi.fn() });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(onDelta).not.toHaveBeenCalled();
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
