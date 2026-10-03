import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUaoServer, type UaoServerInstance } from "../uao-server";
import {
  UAO_CONTENT_SECURITY_POLICY,
  isUaoProxyDocument,
} from "../../shared/content-security-policy";

import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..", "..", "..");

describe("UAO Runtime Static & Proxy Server Security", () => {
  let mockBackend: http.Server;
  let mockBackendPort: number;
  let uaoServer: UaoServerInstance;
  let tempStaticDir: string;
  let outsideDir: string;
  let symlinkPath: string;
  let mockSockets: Set<net.Socket>;
  let finishStream: (() => void) | undefined;
  let streamClosed: Promise<void>;
  const originalToken = process.env.AGENT_OS_TOKEN;

  beforeAll(async () => {
    mockSockets = new Set<net.Socket>();
    // 1. Create temporary static directory with uao.html, an asset file, and a symlink pointing outside
    tempStaticDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-static-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-outside-"));

    fs.writeFileSync(
      path.join(tempStaticDir, "uao.html"),
      "<!doctype html><html><head><title>UAO Shell</title></head><body><div id='root'></div></body></html>",
    );
    const assetsDir = path.join(tempStaticDir, "assets");
    fs.mkdirSync(assetsDir);
    fs.writeFileSync(
      path.join(assetsDir, "app.js"),
      "console.log('uao shell');",
    );

    // Outside file and symlink pointing outside
    const outsideSecret = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideSecret, "sensitive-data");
    symlinkPath = path.join(tempStaticDir, "symlink-outside.txt");
    fs.symlinkSync(outsideSecret, symlinkPath);

    // 2. Spin up a mock backend mimicking 127.0.0.1:5050
    mockBackend = http.createServer((req, res) => {
      const url = req.url ?? "/";

      if (url.startsWith("/?desktop-frame=1")) {
        const html = url.includes("large=1")
          ? "x".repeat(1024 * 1024 + 1)
          : '<html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>';
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "base-uri 'self'; object-src 'none'",
          "Content-Length": Buffer.byteLength(html),
        });
        res.end(html);
        return;
      }

      // Test endpoint: kanban boards
      if (url === "/api/kanban/boards") {
        const tokenHeader = req.headers["x-agent-os-token"] as
          | string
          | undefined;
        const hostHeader = req.headers.host;
        const originHeader = req.headers.origin;

        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-received-token": tokenHeader ?? "",
          "x-received-host": hostHeader ?? "",
          "x-received-origin": originHeader ?? "",
        });
        res.end(JSON.stringify([{ slug: "main", name: "Main Board" }]));
        return;
      }

      // Test endpoint: streaming SSE
      if (url === "/api/events/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("data: first\n\n");
        finishStream = () => res.end("data: second\n\n");
        streamClosed = new Promise<void>((resolve) =>
          res.once("close", resolve),
        );
        return;
      }

      if (url === "/api/redirect") {
        res.writeHead(302, { Location: "/api/kanban/boards" });
        res.end();
        return;
      }

      // Test endpoint: upstream doc with custom CSP
      if (url.startsWith("/hermes-webui")) {
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self' 'unsafe-eval'",
        });
        res.end("<html><body>Hermes WebUI</body></html>");
        return;
      }

      res.writeHead(404);
      res.end("Not Found on Backend");
    });

    // Mock backend upgrade for WebSockets
    mockBackend.on("upgrade", (req, socket) => {
      if (req.url === "/api/rejected-ws") {
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      const host = req.headers.host ?? "";
      const origin = req.headers.origin ?? "";
      const token =
        (req.headers["x-agent-os-token"] as string | undefined) ?? "";

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `x-received-host: ${host}\r\n` +
          `x-received-origin: ${origin}\r\n` +
          `x-received-token: ${token}\r\n\r\n`,
      );

      socket.on("data", (chunk) => {
        socket.write(`echo:${chunk.toString()}`);
      });
    });

    mockBackend.on("connection", (socket) => {
      mockSockets.add(socket);
      socket.on("close", () => mockSockets.delete(socket));
    });

    await new Promise<void>((resolve) => {
      mockBackend.listen(0, "127.0.0.1", () => {
        const addr = mockBackend.address() as net.AddressInfo;
        mockBackendPort = addr.port;
        resolve();
      });
    });

    // Set a runtime token for test
    process.env.AGENT_OS_TOKEN = "test-secret-token";

    // 3. Start UAO server pointing to our mock backend
    uaoServer = await startUaoServer({
      staticDir: tempStaticDir,
      backendPort: mockBackendPort,
    });
  });

  it("bootstraps shared activity before the embedded UI without changing its origin or CSP", async () => {
    const response = await fetch(`${uaoServer.origin}/uao-api/?desktop-frame=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("base-uri 'self'; object-src 'none'");
    const html = await response.text();
    expect(html.indexOf("parent.__uaoActivitySource")).toBeGreaterThan(0);
    expect(html.indexOf("parent.__uaoActivitySource")).toBeLessThan(html.indexOf('type="module"'));
    expect(html).toContain('id="root"');
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(html)));
    expect((await fetch(`${uaoServer.origin}/uao-api/?desktop-frame=1&large=1`)).status).toBe(502);
  });

  afterAll(async () => {
    if (originalToken === undefined) delete process.env.AGENT_OS_TOKEN;
    else process.env.AGENT_OS_TOKEN = originalToken;
    await uaoServer.close();
    for (const socket of mockSockets) {
      socket.destroy();
    }
    mockSockets.clear();
    await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    fs.rmSync(tempStaticDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe("Request Boundary Validation", () => {
    it("reuses an explicitly bound origin across restarts", async () => {
      const first = await startUaoServer({
        staticDir: tempStaticDir,
        backendPort: mockBackendPort,
      });
      const { port, origin } = first;
      await first.close();
      const second = await startUaoServer({
        staticDir: tempStaticDir,
        backendPort: mockBackendPort,
        port,
      });
      try {
        expect(second.origin).toBe(origin);
      } finally {
        await second.close();
      }
    });

    it("rejects non-loopback Host headers with 403 Forbidden", async () => {
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: uaoServer.port,
            path: "/desktop/",
            method: "GET",
            headers: { Host: "evil.attacker.com" },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(statusCode).toBe(403);
    });

    it("rejects untrusted Origin headers with 403 Forbidden", async () => {
      const res = await fetch(`http://127.0.0.1:${uaoServer.port}/desktop/`, {
        headers: { Origin: "http://evil.attacker.com" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects untrusted Referer headers with 403 Forbidden", async () => {
      const res = await fetch(`http://127.0.0.1:${uaoServer.port}/desktop/`, {
        headers: { Referer: "http://evil.attacker.com/page" },
      });
      expect(res.status).toBe(403);
    });

    it("rejects root /sw.js service-worker takeover", async () => {
      const res = await fetch(`http://127.0.0.1:${uaoServer.port}/sw.js`);
      expect(res.status).toBe(404);
    });

    it("rejects requests carrying service-worker: script headers", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/assets/app.js`,
        {
          headers: { "Service-Worker": "script" },
        },
      );
      expect(res.status).toBe(404);
    });

    it("rejects non-GET/HEAD methods on static files with 405 Method Not Allowed", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/uao.html`,
        {
          method: "POST",
        },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toContain("GET");
    });

    it("rejects path traversal attempts outside static directory with 400/403/404", async () => {
      const res1 = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/../../package.json`,
      );
      expect([403, 404]).toContain(res1.status);

      const res2 = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/%2e%2e%2f%2e%2e%2fpackage.json`,
      );
      expect([403, 404]).toContain(res2.status);

      const resNull = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/%00foo.html`,
      );
      expect(resNull.status).toBe(400);
    });

    it("rejects encoded traversal even when the target exists inside the static root", async () => {
      const response = await fetch(
        `${uaoServer.origin}/desktop/%2e%2e%2fuao.html`,
      );
      expect(response.status).toBe(403);
    });

    it("rejects malformed URL escapes without crashing the runtime", async () => {
      const response = await fetch(`${uaoServer.origin}/desktop/%ZZ`);
      expect(response.status).toBe(400);
      expect((await fetch(`${uaoServer.origin}/desktop/uao.html`)).status).toBe(
        200,
      );
    });

    it("rejects unexpected proxy methods", async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          `${uaoServer.origin}/api/ping`,
          { method: "TRACE" },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(405);
    });

    it("rejects browser cross-site requests even without Origin or Referer", async () => {
      const response = await fetch(`${uaoServer.origin}/api/ping`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status).toBe(403);
    });

    it("rejects static symlinks pointing outside the packaged root", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/symlink-outside.txt`,
      );
      expect(res.status).toBe(403);
    });

    it("rejects unexpected paths that are neither /desktop/ nor bounded proxy paths (no open proxy)", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/unmapped/malicious/probe`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("Static Renderer Serving & CSP Matching", () => {
    it("serves compiled uao.html under /desktop/ and /desktop with exact CSP header", async () => {
      const resSlash = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/`,
      );
      expect(resSlash.status).toBe(200);
      expect(resSlash.headers.get("Content-Type")).toContain("text/html");
      const cspHeader = resSlash.headers.get("Content-Security-Policy");
      expect(cspHeader).toBe(UAO_CONTENT_SECURITY_POLICY);
      expect(cspHeader).toContain("frame-src 'self'");

      const text = await resSlash.text();
      expect(text).toContain("<title>UAO Shell</title>");

      const resNoSlash = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop`,
      );
      expect(resNoSlash.status).toBe(200);
    });

    it("serves compiled assets with appropriate Content-Type", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/desktop/assets/app.js`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/javascript");
    });
  });

  describe("Bounded Proxy Routing & HTTP/SSE Forwarding", () => {
    it("correctly routes and strips /uao-api prefix while injecting backend host, origin, and runtime token", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/uao-api/api/kanban/boards`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-received-token")).toBe("test-secret-token");
      expect(res.headers.get("x-received-host")).toBe(
        `127.0.0.1:${mockBackendPort}`,
      );
      expect(res.headers.get("x-received-origin")).toBe(
        `http://127.0.0.1:${mockBackendPort}`,
      );

      const data = await res.json();
      expect(data).toEqual([{ slug: "main", name: "Main Board" }]);
    });

    it("preserves streaming text/event-stream responses (SSE)", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/api/events/stream`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Missing streaming body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
      expect(first.done).toBe(false);
      finishStream?.();
      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
      expect((await reader.read()).done).toBe(true);
    });

    it("cancels the backend stream when the desktop reader disconnects", async () => {
      const response = await fetch(`${uaoServer.origin}/api/events/stream`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing streaming body");
      await reader.read();
      await reader.cancel();
      await streamClosed;
    });

    it("keeps /uao-api redirects inside the same proxy prefix", async () => {
      const response = await fetch(`${uaoServer.origin}/uao-api/api/redirect`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "/uao-api/api/kanban/boards",
      );
    });

    it("preserves upstream CSP only on explicitly matched proxy docs", async () => {
      const res = await fetch(
        `http://127.0.0.1:${uaoServer.port}/hermes-webui/`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self' 'unsafe-eval'",
      );
      expect(
        isUaoProxyDocument(
          `http://127.0.0.1:${uaoServer.port}/hermes-webui/`,
          `http://127.0.0.1:${uaoServer.port}`,
        ),
      ).toBe(true);
    });

    it("handles backend down gracefully with 502 Bad Gateway and no server crash", async () => {
      // Point to an unused local port
      const badServer = await startUaoServer({
        staticDir: tempStaticDir,
        backendPort: 54321,
      });

      try {
        const res = await fetch(
          `http://127.0.0.1:${badServer.port}/uao-api/api/kanban/boards`,
        );
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).toContain("UAO backend unreachable");

        // Shell still serves even when backend is down!
        const shellRes = await fetch(
          `http://127.0.0.1:${badServer.port}/desktop/uao.html`,
        );
        expect(shellRes.status).toBe(200);
      } finally {
        await badServer.close();
      }
    });
  });

  describe("WebSocket Upgrade Proxying", () => {
    it("proxies WebSocket upgrades with correct backend host, origin, and auth token", async () => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: uaoServer.port,
      });

      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => {
          socket.write(
            `GET /uao-api/ws HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${uaoServer.port}\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
              `Sec-WebSocket-Version: 13\r\n\r\n`,
          );
        });

        socket.on("data", (chunk) => {
          const resp = chunk.toString();
          if (resp.includes("101 Switching Protocols")) {
            expect(resp).toContain("101 Switching Protocols");
            expect(resp).toContain(
              `x-received-host: 127.0.0.1:${mockBackendPort}`,
            );
            expect(resp).toContain(
              `x-received-origin: http://127.0.0.1:${mockBackendPort}`,
            );
            expect(resp).toContain("x-received-token: test-secret-token");

            // Test echo communication over upgraded socket
            socket.write("hello-uao");
          } else if (resp.includes("echo:hello-uao")) {
            socket.destroy();
            resolve();
          }
        });

        socket.on("error", reject);
      });
    });

    it("returns rejected backend upgrades and closes the connection", async () => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: uaoServer.port,
      });
      let response = "";
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () =>
          socket.write(
            `GET /api/rejected-ws HTTP/1.1\r\nHost: 127.0.0.1:${uaoServer.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
          ),
        );
        socket.on("data", (chunk) => {
          response += chunk.toString();
        });
        socket.on("close", resolve);
        socket.on("error", reject);
      });
      expect(response).toContain("403 Forbidden");
    });

    it("destroys WebSocket upgrades on unmapped paths", async () => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: uaoServer.port,
      });

      await new Promise<void>((resolve) => {
        socket.on("connect", () => {
          socket.write(
            `GET /unmapped/ws HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${uaoServer.port}\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n\r\n`,
          );
        });
        socket.on("close", () => {
          resolve();
        });
      });
    });
  });
});

describe("UAO Packaging Contract & Isolation", () => {
  it("verifies electron-builder.uao.json configuration satisfies contract", () => {
    const configPath = path.join(desktopRoot, "electron-builder.uao.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);

    // Product & Executable Name
    expect(parsed.productName).toBe("UAO");
    expect(parsed.linux.executableName).toBe("uao-desktop");
    expect(parsed.extraMetadata.main).toBe("dist/main-uao/index.js");

    // Output directory isolated from Traycer
    expect(parsed.directories.output).toBe("release-uao");

    // Disabled inherited hooks, protocols, and publishing
    expect(parsed.afterPack).toBeNull();
    expect(parsed.protocols).toEqual([]);
    expect(parsed.publish).toBeNull();

    // GenOffice assets and engines are separate from Traycer CLI/Host.
    const officeResources = [{ from: "resources/genoffice", to: ".", filter: ["**/*"] }];
    expect(parsed.extraResources).toEqual(officeResources);
    expect(parsed.linux.extraResources).toEqual(officeResources);
    expect(parsed.mac.extraResources).toEqual([]);
    expect(parsed.win.extraResources).toEqual([]);

    // Electron Security Fuses retained
    expect(parsed.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
    });

    // Bundles only UAO outputs
    expect(parsed.files).toContain("dist/main-uao/**/*");
    expect(parsed.files).toContain("dist/renderer-uao/**/*");
  });

  it("verifies normal Traycer desktop package.json remains intact", () => {
    const pkgPath = path.join(desktopRoot, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);

    // Normal build section must stay intact
    expect(parsed.build.productName).toBe("Traycer");
    expect(parsed.build.appId).toBe("ai.traycer.desktop");
    expect(parsed.build.directories.output).toBe("release");
    expect(parsed.build.afterPack).toBe(
      "scripts/prepack/inject-host-launch-agent.cjs",
    );
    expect(parsed.main).toBe("dist/main/index.js");

    // UAO scripts exist in package.json
    expect(parsed.scripts["build:uao"]).toBeDefined();
    expect(parsed.scripts["build:uao:main"]).toBeDefined();
    expect(parsed.scripts["build:uao:renderer"]).toBeDefined();
    expect(parsed.scripts["package:uao"]).toBeDefined();
    expect(parsed.scripts["package:uao:dir"]).toBeDefined();
  });
});
