import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  remapServerOrcaPath,
  startUaoServer,
  type UaoServerInstance,
} from "../uao-server";

const SECRET = "s".repeat(40);
const servers: UaoServerInstance[] = [];
const dirs: string[] = [];

async function start(
  extra: Partial<Parameters<typeof startUaoServer>[0]>,
): Promise<UaoServerInstance> {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-orca-"));
  dirs.push(staticDir);
  const server = await startUaoServer({ staticDir, backendPort: 1, ...extra });
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("remapServerOrcaPath", () => {
  it("maps only the server-Orca prefix onto the gateway's Orca routes", () => {
    expect(remapServerOrcaPath("/uao-api/orca-server")).toBe("/uao-api/orca");
    expect(remapServerOrcaPath("/uao-api/orca-server/terminal/stream")).toBe(
      "/uao-api/orca/terminal/stream",
    );
    expect(remapServerOrcaPath("/uao-api/orca/status")).toBeNull();
    expect(remapServerOrcaPath("/uao-api/orca-serverx")).toBeNull();
  });
});

describe("desktop with no upstream", () => {
  it("reports no server Orca and refuses the server prefix", async () => {
    const server = await start({});
    const config = await fetch(`${server.origin}/desktop/uao-config.json`);
    expect(await config.json()).toEqual({ orcaServer: false });
    const orca = await fetch(`${server.origin}/uao-api/orca-server/status`);
    expect(orca.status).toBe(404);
  });
});

describe("pairing gateway with Orca on", () => {
  it("needs the pairing header, not just the pairing cookie", async () => {
    process.env.ORCA_BIN = "/nonexistent/orca";
    const server = await start({ pairingSecret: SECRET, orca: true });
    const url = `${server.origin}/uao-api/orca/status`;

    expect((await fetch(url)).status).toBe(401);

    const pair = await fetch(`${server.origin}/uao-pair?token=${SECRET}`, {
      redirect: "manual",
    });
    const cookie = (pair.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("uao_pair=");
    const byCookie = await fetch(url, { headers: { Cookie: cookie } });
    expect(byCookie.status).toBe(403);

    const byHeader = await fetch(url, {
      headers: { "x-uao-pairing": SECRET },
    });
    // Past the gate: the handler ran and failed on the missing CLI.
    expect(byHeader.status).toBe(502);
  });
});
