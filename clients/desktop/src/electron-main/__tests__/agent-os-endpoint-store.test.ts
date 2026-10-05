import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_DEFAULT_ENDPOINTS,
} from "@traycer-clients/shared/agent-os-endpoints";
import {
  collectTailscaleCleartextSwitch,
  readAgentOsEndpoints,
  readAgentOsPublicConfig,
  readAgentOsToken,
  writeAgentOsEndpoints,
  writeAgentOsToken,
  type AgentOsSecretStore,
} from "../agent-os-endpoint-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-agent-os-"));
  dirs.push(dir);
  return dir;
}

function secrets(available: boolean): AgentOsSecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) =>
      Buffer.from(`sealed:${plain.split("").reverse().join("")}`),
    decryptString: (cipher) => {
      const text = cipher.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed");
      return text.slice("sealed:".length).split("").reverse().join("");
    },
  };
}

describe("Agent OS endpoint store", () => {
  it("starts from the Tailscale defaults and does not create a file", () => {
    const dir = tempDir();
    expect(readAgentOsEndpoints(dir)).toEqual(AGENT_OS_DEFAULT_ENDPOINTS);
    expect(readAgentOsPublicConfig(dir).embedUrl).toBe(
      "http://100.90.167.20:5050/?embed=1#overview",
    );
    expect(readAgentOsPublicConfig(dir).tokens).toEqual({
      "agent-os": false,
      hermes: false,
      omniroute: false,
    });
    expect(collectTailscaleCleartextSwitch(dir)).toBe(
      "http://100.90.167.20:5050,http://100.90.167.20:8787,http://100.90.167.20:20128",
    );
  });

  it("writes addresses only, never a token, and falls back when the file is garbage", () => {
    const dir = tempDir();
    writeAgentOsEndpoints(dir, {
      baseUrl: "http://100.90.167.20:5050/extra",
      hermesUrl: AGENT_OS_DEFAULT_ENDPOINTS.hermesUrl,
      omnirouteUrl: AGENT_OS_DEFAULT_ENDPOINTS.omnirouteUrl,
      localSupervisor: true,
    });
    const file = path.join(dir, "agent-os-endpoints.json");
    expect(fs.readFileSync(file, "utf8")).not.toContain("token");
    expect(readAgentOsEndpoints(dir).baseUrl).toBe(AGENT_OS_DEFAULT_BASE_URL);
    expect(readAgentOsEndpoints(dir).localSupervisor).toBe(true);
    expect(readAgentOsPublicConfig(dir).embedUrl).toBe(
      "http://127.0.0.1:5050/?embed=1#overview",
    );
    fs.writeFileSync(file, "{");
    expect(readAgentOsEndpoints(dir)).toEqual(AGENT_OS_DEFAULT_ENDPOINTS);
  });

  it("stores ciphertext and refuses a token when encryption is unavailable", () => {
    const dir = tempDir();
    writeAgentOsEndpoints(dir, AGENT_OS_DEFAULT_ENDPOINTS);
    const token = "super-secret-token";
    const refused = writeAgentOsToken(dir, secrets(false), "hermes", token);
    expect(refused).toEqual({
      ok: false,
      error: "The OS keychain is unavailable, so the token was not saved.",
    });
    expect(fs.existsSync(path.join(dir, "agent-os-tokens", "hermes"))).toBe(
      false,
    );

    expect(writeAgentOsToken(dir, secrets(true), "hermes", token)).toEqual({
      ok: true,
    });
    const sealed = fs.readFileSync(path.join(dir, "agent-os-tokens", "hermes"));
    expect(sealed.toString("utf8")).not.toContain(token);
    expect(readAgentOsToken(dir, secrets(true), "hermes")).toBe(token);
    expect(readAgentOsPublicConfig(dir).tokens.hermes).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, "agent-os-endpoints.json"), "utf8"),
    ).not.toContain(token);

    expect(writeAgentOsToken(dir, secrets(true), "hermes", "  ")).toEqual({
      ok: true,
    });
    expect(fs.existsSync(path.join(dir, "agent-os-tokens", "hermes"))).toBe(
      false,
    );
  });
});
