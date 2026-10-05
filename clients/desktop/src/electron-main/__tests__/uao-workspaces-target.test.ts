import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  remapServerWorkspacesPath,
  startUaoServer,
  type UaoServerInstance,
} from "../uao-server";
import { WorkspaceRuntime } from "../uao-workspace-runtime";

const SECRET = "s".repeat(40);
const servers: UaoServerInstance[] = [];
const dirs: string[] = [];

async function start(
  extra: Partial<Parameters<typeof startUaoServer>[0]>,
): Promise<UaoServerInstance> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uao-ws-target-"));
  dirs.push(root);
  const server = await startUaoServer({
    staticDir: root,
    backendPort: 1,
    workspaceRuntime: new WorkspaceRuntime({
      dataDir: path.join(root, "data"),
      tmuxSocket: `uao-test-${process.pid}-${dirs.length}`,
    }),
    ...extra,
  });
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("remapServerWorkspacesPath", () => {
  it("maps only the server prefix onto the gateway's workspace routes", () => {
    expect(remapServerWorkspacesPath("/uao-api/workspaces-server")).toBe(
      "/uao-api/workspaces",
    );
    expect(
      remapServerWorkspacesPath("/uao-api/workspaces-server/terminal/stream"),
    ).toBe("/uao-api/workspaces/terminal/stream");
    expect(remapServerWorkspacesPath("/uao-api/workspaces/status")).toBeNull();
    expect(remapServerWorkspacesPath("/uao-api/workspaces-serverx")).toBeNull();
  });
});

describe("desktop with no upstream", () => {
  it("reports no server and refuses the server prefix", async () => {
    const server = await start({});
    const config = await fetch(`${server.origin}/desktop/uao-config.json`);
    expect(await config.json()).toEqual({ workspacesServer: false });
    const remote = await fetch(`${server.origin}/uao-api/workspaces-server/status`);
    expect(remote.status).toBe(404);
  });

  it("serves its own workspace runtime", async () => {
    const server = await start({});
    const status = await fetch(`${server.origin}/uao-api/workspaces/status`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as { ok: boolean; result: { runtime: { runtimeId: string } } };
    expect(body.ok).toBe(true);
    expect(body.result.runtime.runtimeId).toMatch(/^uao-/);
  });
});

describe("pairing gateway with workspaces on", () => {
  it("needs the pairing header, not just the pairing cookie", async () => {
    const server = await start({ pairingSecret: SECRET, workspaces: true });
    const url = `${server.origin}/uao-api/workspaces/status`;

    expect((await fetch(url)).status).toBe(401);

    const pair = await fetch(`${server.origin}/uao-pair?token=${SECRET}`, {
      redirect: "manual",
    });
    const cookie = (pair.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("uao_pair=");
    expect((await fetch(url, { headers: { Cookie: cookie } })).status).toBe(403);

    expect((await fetch(url, { headers: { "x-uao-pairing": SECRET } })).status).toBe(200);
  });

  it("serves no workspace routes when switched off", async () => {
    const server = await start({ pairingSecret: SECRET, workspaces: false });
    const response = await fetch(`${server.origin}/uao-api/workspaces/status`, {
      headers: { "x-uao-pairing": SECRET },
    });
    expect(response.status).toBe(404);
  });
});
