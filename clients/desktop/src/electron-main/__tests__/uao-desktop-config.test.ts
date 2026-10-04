import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startUaoServer, type UaoServerInstance } from "../uao-server";

const servers: UaoServerInstance[] = [];
const dirs: string[] = [];

async function start(jarvisUrl?: string): Promise<UaoServerInstance> {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-config-"));
  dirs.push(staticDir);
  const server = await startUaoServer({
    staticDir,
    backendPort: 1,
    jarvisUrl,
  });
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("UAO desktop runtime config", () => {
  it("reports the server-hosted Jarvis URL to the renderer", async () => {
    const server = await start("https://server.example.ts.net:10000/");
    const response = await fetch(`${server.origin}/desktop/uao-config.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      jarvisUrl: "https://server.example.ts.net:10000/",
    });
  });

  it("reports no Jarvis URL when Jarvis is local", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/desktop/uao-config.json`);
    expect(await response.json()).toEqual({ jarvisUrl: null });
  });
});
