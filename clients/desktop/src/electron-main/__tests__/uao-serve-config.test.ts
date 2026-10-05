import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePairingSecret, parseServeConfig } from "../uao-serve-config";

const STATIC = "/srv/uao/renderer";
const GOOD = "g".repeat(40);

describe("parseServeConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  function secretFile(contents: string, mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-serve-"));
    dirs.push(dir);
    const file = path.join(dir, "secret");
    fs.writeFileSync(file, contents, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  it("defaults to loopback, port 5191, backend 5050, workspace off, no secret", () => {
    expect(parseServeConfig({}, STATIC)).toEqual({
      host: "127.0.0.1",
      port: 5191,
      backendPort: 5050,
      staticDir: STATIC,
      allowedOrigins: [],
      pairingSecret: undefined,
      workspaces: false,
    });
  });

  it("reads host, ports, static dir, origins and the workspace opt-in", () => {
    const config = parseServeConfig(
      {
        UAO_SERVE_HOST: "100.90.167.20",
        UAO_SERVE_PORT: "6000",
        UAO_BACKEND_PORT: "5055",
        UAO_SERVE_STATIC_DIR: "/tmp/ui",
        UAO_SERVE_ALLOWED_ORIGINS: " https://a.example , https://b.example ,,",
        UAO_PAIRING_SECRET: GOOD,
        UAO_SERVE_WORKSPACES: "1",
      },
      STATIC,
    );
    expect(config).toMatchObject({
      host: "100.90.167.20",
      port: 6000,
      backendPort: 5055,
      staticDir: "/tmp/ui",
      allowedOrigins: ["https://a.example", "https://b.example"],
      pairingSecret: GOOD,
      workspaces: true,
    });
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseServeConfig({ UAO_SERVE_PORT: "70000" }, STATIC)).toThrow(
      /UAO_SERVE_PORT/,
    );
    expect(() => parseServeConfig({ UAO_BACKEND_PORT: "abc" }, STATIC)).toThrow(
      /UAO_BACKEND_PORT/,
    );
  });

  it("rejects a short secret", () => {
    expect(() =>
      parseServeConfig({ UAO_PAIRING_SECRET: "short" }, STATIC),
    ).toThrow(/at least 32/);
  });

  it("prefers the secret file and trims it", () => {
    const file = secretFile(`${GOOD}\n`, 0o600);
    const config = parseServeConfig(
      { UAO_PAIRING_SECRET_FILE: file, UAO_PAIRING_SECRET: "ignored" },
      STATIC,
    );
    expect(config.pairingSecret).toBe(GOOD);
  });

  it("refuses a secret file readable by group or others", () => {
    const file = secretFile(GOOD, 0o640);
    expect(() =>
      parseServeConfig({ UAO_PAIRING_SECRET_FILE: file }, STATIC),
    ).toThrow(/chmod 600/);
  });

  it("generates secrets that satisfy the minimum length and differ per call", () => {
    const a = generatePairingSecret();
    const b = generatePairingSecret();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});
