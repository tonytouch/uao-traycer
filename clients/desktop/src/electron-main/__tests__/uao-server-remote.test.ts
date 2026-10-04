import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  startUaoServer,
  UAO_PAIR_COOKIE,
  UAO_PAIR_HEADER,
  UAO_PAIR_PATH,
  type UaoServerInstance,
} from "../uao-server";

const SECRET = "s".repeat(24) + "0123456789abcdef"; // 40 chars
const TAILNET_HOST = "uao.example.ts.net";
const TAILNET_ORIGIN = `https://${TAILNET_HOST}`;

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  pathName: string,
  headers: http.OutgoingHttpHeaders,
  method: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function get(port: number, pathName: string): Promise<Reply> {
  return send(port, pathName, {}, "GET");
}

function getWith(
  port: number,
  pathName: string,
  headers: http.OutgoingHttpHeaders,
): Promise<Reply> {
  return send(port, pathName, headers, "GET");
}

function cookieFrom(reply: Reply): string {
  const raw = reply.headers["set-cookie"]?.[0] ?? "";
  return raw.split(";")[0] ?? "";
}

describe("UAO server remote hosting options", () => {
  let backend: http.Server;
  let backendPort: number;
  let staticDir: string;
  let seen: http.IncomingHttpHeaders[];
  let upgradeSeen: number;
  const originalToken = process.env.AGENT_OS_TOKEN;
  const instances: UaoServerInstance[] = [];

  beforeAll(async () => {
    process.env.AGENT_OS_TOKEN = "backend-token";
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-remote-static-"));
    fs.writeFileSync(path.join(staticDir, "uao.html"), "<html>uao</html>");
    seen = [];
    upgradeSeen = 0;
    backend = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    backend.on("upgrade", (_req, socket) => {
      upgradeSeen += 1;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.end();
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    backendPort = (backend.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of instances) await s.close();
    await new Promise<void>((r) => {
      backend.closeAllConnections();
      backend.close(() => r());
    });
    fs.rmSync(staticDir, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.AGENT_OS_TOKEN;
    else process.env.AGENT_OS_TOKEN = originalToken;
  });

  async function start(
    extra: Parameters<typeof startUaoServer>[0] extends infer T
      ? Partial<T>
      : never,
  ): Promise<UaoServerInstance> {
    const server = await startUaoServer({
      staticDir,
      backendPort,
      host: "127.0.0.1",
      pairingSecret: SECRET,
      allowedOrigins: [TAILNET_ORIGIN],
      ...extra,
    } as Parameters<typeof startUaoServer>[0]);
    instances.push(server);
    return server;
  }

  describe("fail-closed configuration", () => {
    it("refuses a non-loopback bind without a pairing secret", async () => {
      await expect(
        startUaoServer({
          staticDir,
          backendPort,
          host: "0.0.0.0",
        } as Parameters<typeof startUaoServer>[0]),
      ).rejects.toThrow(/pairing secret is required/i);
    });

    it("refuses extra allowed origins without a pairing secret", async () => {
      await expect(
        startUaoServer({
          staticDir,
          backendPort,
          allowedOrigins: [TAILNET_ORIGIN],
        } as Parameters<typeof startUaoServer>[0]),
      ).rejects.toThrow(/pairing secret is required/i);
    });

    it("refuses a short pairing secret", async () => {
      await expect(
        startUaoServer({
          staticDir,
          backendPort,
          pairingSecret: "too-short",
        } as Parameters<typeof startUaoServer>[0]),
      ).rejects.toThrow(/at least 32/);
    });

    it.each(["not a url", "ftp://x.example", `${TAILNET_ORIGIN}/path`])(
      "refuses malformed allowed origin %s",
      async (origin) => {
        await expect(
          startUaoServer({
            staticDir,
            backendPort,
            pairingSecret: SECRET,
            allowedOrigins: [origin],
          } as Parameters<typeof startUaoServer>[0]),
        ).rejects.toThrow(/origin/i);
      },
    );
  });

  describe("allowed origins", () => {
    let server: UaoServerInstance;
    beforeAll(async () => {
      server = await start({});
    });

    it("accepts the configured Host after pairing and rejects others", async () => {
      const paired = await getWith(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        { Host: TAILNET_HOST },
      );
      expect(paired.status).toBe(303);
      const ok = await getWith(server.port, "/desktop/uao.html", {
        Host: TAILNET_HOST,
        Cookie: cookieFrom(paired),
      });
      expect(ok.status).toBe(200);

      const wrongHost = await getWith(server.port, "/desktop/uao.html", {
        Host: "evil.example.com",
        Cookie: cookieFrom(paired),
      });
      expect(wrongHost.status).toBe(403);
    });

    it("accepts the configured Origin/Referer and rejects unlisted ones", async () => {
      const paired = await getWith(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        { Host: TAILNET_HOST },
      );
      const cookie = cookieFrom(paired);
      const good = await getWith(server.port, "/desktop/uao.html", {
        Host: TAILNET_HOST,
        Cookie: cookie,
        Origin: TAILNET_ORIGIN,
        Referer: `${TAILNET_ORIGIN}/desktop/uao.html`,
      });
      expect(good.status).toBe(200);
      const bad = await getWith(server.port, "/desktop/uao.html", {
        Host: TAILNET_HOST,
        Cookie: cookie,
        Origin: "https://evil.example.com",
      });
      expect(bad.status).toBe(403);
    });

    it("keeps loopback Host working", async () => {
      const paired = await get(server.port, `${UAO_PAIR_PATH}?token=${SECRET}`);
      expect(paired.status).toBe(303);
    });
  });

  describe("pairing gate", () => {
    let server: UaoServerInstance;
    beforeAll(async () => {
      server = await start({});
    });

    it.each([
      "/desktop/uao.html",
      "/uao-api/api/hermes/kanban/boards",
      "/api/health",
      "/uao-api/orca/status",
    ])("returns 401 for unpaired %s", async (p) => {
      const res = await get(server.port, p);
      expect(res.status).toBe(401);
    });

    it("never reaches the backend when unpaired", async () => {
      const before = seen.length;
      await get(server.port, "/uao-api/api/hermes/kanban/boards");
      expect(seen.length).toBe(before);
    });

    it("sets an HttpOnly SameSite=Lax cookie that is not the raw secret", async () => {
      const res = await getWith(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        { Host: TAILNET_HOST },
      );
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/desktop/uao.html");
      const raw = res.headers["set-cookie"]?.[0] ?? "";
      expect(raw).toContain(`${UAO_PAIR_COOKIE}=`);
      expect(raw).toContain("HttpOnly");
      expect(raw).toContain("SameSite=Lax");
      expect(raw).toContain("Secure");
      expect(raw).not.toContain(SECRET);
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("omits Secure on a plain-http loopback pairing", async () => {
      const res = await get(server.port, `${UAO_PAIR_PATH}?token=${SECRET}`);
      expect(res.headers["set-cookie"]?.[0]).not.toContain("Secure");
    });

    it("accepts the pairing header and rejects a wrong one", async () => {
      const ok = await getWith(server.port, "/desktop/uao.html", {
        [UAO_PAIR_HEADER]: SECRET,
      });
      expect(ok.status).toBe(200);
      const bad = await getWith(server.port, "/desktop/uao.html", {
        [UAO_PAIR_HEADER]: "x".repeat(40),
      });
      expect(bad.status).toBe(401);
    });

    it("rejects a forged cookie", async () => {
      const res = await getWith(server.port, "/desktop/uao.html", {
        Cookie: `${UAO_PAIR_COOKIE}=${SECRET}`,
      });
      expect(res.status).toBe(401);
    });

    it("only allows GET on the pairing path", async () => {
      const res = await send(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        {},
        "POST",
      );
      expect(res.status).toBe(405);
    });

    it("throttles repeated wrong pairing tokens", async () => {
      const throttled = await start({});
      for (let i = 0; i < 10; i += 1) {
        const res = await get(
          throttled.port,
          `${UAO_PAIR_PATH}?token=wrong-${i}`,
        );
        expect(res.status).toBe(401);
      }
      const locked = await get(
        throttled.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
      );
      expect(locked.status).toBe(429);
    });

    it("does not throttle a valid cookie holder after failures", async () => {
      const s = await start({});
      const paired = await get(s.port, `${UAO_PAIR_PATH}?token=${SECRET}`);
      const cookie = cookieFrom(paired);
      for (let i = 0; i < 12; i += 1) {
        await get(s.port, `${UAO_PAIR_PATH}?token=wrong-${i}`);
      }
      const res = await getWith(s.port, "/desktop/uao.html", {
        Cookie: cookie,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("cross-site navigation from the app launcher", () => {
    const nav = {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      Referer: "https://localhost/",
    };
    let server: UaoServerInstance;
    beforeAll(async () => {
      server = await start({});
    });

    it("allows the pairing hand-off and the shell it redirects to", async () => {
      const paired = await getWith(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        { Host: TAILNET_HOST, ...nav },
      );
      expect(paired.status).toBe(303);
      expect(paired.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
      const shell = await getWith(server.port, "/desktop/uao.html", {
        Host: TAILNET_HOST,
        Cookie: cookieFrom(paired),
        ...nav,
      });
      expect(shell.status).toBe(200);
    });

    it("rejects cross-site navigation to anything else", async () => {
      for (const p of [
        "/uao-api/api/hermes/kanban/boards",
        "/desktop/assets/app.js",
        "/api/health",
      ]) {
        const res = await getWith(server.port, p, {
          [UAO_PAIR_HEADER]: SECRET,
          ...nav,
        });
        expect(res.status, p).toBe(403);
      }
    });

    it("rejects cross-site subresource requests to the pairing path", async () => {
      const res = await getWith(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" },
      );
      expect(res.status).toBe(403);
    });

    it("rejects cross-site non-GET requests to the pairing path", async () => {
      const res = await send(
        server.port,
        `${UAO_PAIR_PATH}?token=${SECRET}`,
        nav,
        "POST",
      );
      expect(res.status).toBe(403);
    });

    it("keeps rejecting cross-site navigation when pairing is off", async () => {
      const open = await startUaoServer({
        staticDir,
        backendPort,
      } as Parameters<typeof startUaoServer>[0]);
      instances.push(open);
      const res = await getWith(open.port, "/desktop/uao.html", nav);
      expect(res.status).toBe(403);
    });
  });

  describe("proxy hygiene", () => {
    it("strips pairing credentials and client network identity before the backend", async () => {
      const server = await start({});
      const paired = await get(server.port, `${UAO_PAIR_PATH}?token=${SECRET}`);
      const cookie = cookieFrom(paired);
      seen.length = 0;
      const res = await getWith(server.port, "/uao-api/api/ping", {
        Cookie: `theme=dark; ${cookie}`,
        "X-Forwarded-For": "100.64.0.9",
        "X-Real-IP": "100.64.0.9",
        Forwarded: "for=100.64.0.9",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "evil.example.com",
        "Tailscale-User-Login": "someone@example.com",
        "Tailscale-User-Name": "Someone",
        "Tailscale-App-Capabilities": "{}",
      });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      const h = seen[0]!;
      expect(h.cookie).toBe("theme=dark");
      expect(h[UAO_PAIR_HEADER]).toBeUndefined();
      expect(h["x-forwarded-for"]).toBeUndefined();
      expect(h["x-real-ip"]).toBeUndefined();
      expect(h.forwarded).toBeUndefined();
      expect(h["x-forwarded-proto"]).toBeUndefined();
      expect(h["x-forwarded-host"]).toBeUndefined();
      expect(Object.keys(h).filter((k) => k.startsWith("tailscale-"))).toEqual(
        [],
      );
      expect(h["x-agent-os-token"]).toBe("backend-token");
    });

    it("drops the cookie header entirely when only the pairing cookie was sent", async () => {
      const server = await start({});
      const paired = await get(server.port, `${UAO_PAIR_PATH}?token=${SECRET}`);
      seen.length = 0;
      await getWith(server.port, "/uao-api/api/ping", {
        Cookie: cookieFrom(paired),
      });
      expect(seen[0]!.cookie).toBeUndefined();
    });
  });

  describe("orca routes", () => {
    it("returns 404 when orca is disabled, even when paired", async () => {
      const server = await start({ orca: false });
      const res = await getWith(server.port, "/uao-api/orca/status", {
        [UAO_PAIR_HEADER]: SECRET,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("websocket upgrades", () => {
    function upgrade(
      port: number,
      headers: Record<string, string>,
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          const lines = [
            "GET /api/ws HTTP/1.1",
            `Host: 127.0.0.1:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            "",
            "",
          ];
          socket.write(lines.join("\r\n"));
        });
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (c: string) => (data += c));
        socket.on("close", () => resolve(data));
        socket.on("error", reject);
      });
    }

    it("answers 401 without reaching the backend when unpaired", async () => {
      const server = await start({});
      const before = upgradeSeen;
      const reply = await upgrade(server.port, {});
      expect(reply).toContain("401");
      expect(upgradeSeen).toBe(before);
    });

    it("proxies the upgrade when paired", async () => {
      const server = await start({});
      const before = upgradeSeen;
      const reply = await upgrade(server.port, { [UAO_PAIR_HEADER]: SECRET });
      expect(reply).toContain("101");
      expect(upgradeSeen).toBe(before + 1);
    });
  });

  it("reports the bound host in the instance origin", async () => {
    const server = await start({});
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
  });
});
