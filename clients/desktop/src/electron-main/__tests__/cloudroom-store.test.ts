import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLOUDROOM_DEFAULT_BASE_URL } from "@traycer-clients/shared/cloudroom";
import {
  readAgentOsPublicConfig,
  readAgentOsToken,
  writeAgentOsToken,
  type AgentOsSecretStore,
} from "../agent-os-endpoint-store";
import {
  collectUaoCleartextSwitch,
  readCloudroomPublicConfig,
  writeCloudroomBaseUrl,
} from "../cloudroom-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-cloudroom-"));
  dirs.push(dir);
  return dir;
}

function secrets(): AgentOsSecretStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) =>
      Buffer.from(`sealed:${plain.split("").reverse().join("")}`),
    decryptString: (cipher) => {
      const text = cipher.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed");
      return text.slice("sealed:".length).split("").reverse().join("");
    },
  };
}

describe("CloudRoom endpoint store", () => {
  it("defaults the Tailscale URL and stores the token beside the Phase 1 tokens", () => {
    const dir = tempDir();
    expect(readCloudroomPublicConfig(dir)).toEqual({
      baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
      tokenSaved: false,
    });
    expect(collectUaoCleartextSwitch(dir)).toBe(
      "http://100.90.167.20:5050,http://100.90.167.20:8787,http://100.90.167.20:20128,http://100.90.167.20:9840,http://100.90.167.20:8081,http://100.90.167.20:8797",
    );

    const token = "cloudroom-token-value";
    expect(writeAgentOsToken(dir, secrets(), "cloudroom", token)).toEqual({
      ok: true,
    });
    const sealed = fs.readFileSync(
      path.join(dir, "agent-os-tokens", "cloudroom"),
    );
    expect(sealed.toString("utf8")).not.toContain(token);
    expect(readAgentOsToken(dir, secrets(), "cloudroom")).toBe(token);
    expect(readCloudroomPublicConfig(dir).tokenSaved).toBe(true);
    expect(readAgentOsPublicConfig(dir).tokens).toEqual({
      "agent-os": false,
      hermes: false,
      omniroute: false,
    });

    writeCloudroomBaseUrl(dir, "http://100.90.1.2:9840");
    const file = fs.readFileSync(path.join(dir, "cloudroom.json"), "utf8");
    expect(file).not.toContain(token);
    expect(readCloudroomPublicConfig(dir).baseUrl).toBe(
      "http://100.90.1.2:9840",
    );
    expect(collectUaoCleartextSwitch(dir)).toContain("http://100.90.1.2:9840");
  });

  it("keeps a blank URL and ignores a garbage file", () => {
    const dir = tempDir();
    writeCloudroomBaseUrl(dir, "");
    expect(readCloudroomPublicConfig(dir).baseUrl).toBe("");
    fs.writeFileSync(path.join(dir, "cloudroom.json"), "{");
    expect(readCloudroomPublicConfig(dir).baseUrl).toBe(
      CLOUDROOM_DEFAULT_BASE_URL,
    );
  });
});
