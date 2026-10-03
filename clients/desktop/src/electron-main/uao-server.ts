import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import {
  UAO_CONTENT_SECURITY_POLICY,
  isUaoProxyDocument,
} from "../shared/content-security-policy";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export const UAO_PROXY_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon192.png",
  "/icon512.png",
  "/icons.svg",
]);

export const UAO_PROXY_DIR_PREFIXES: readonly string[] = [
  "/uao-api",
  "/assets",
  "/api",
  "/hermes-webui",
  "/omnigent",
  "/openmaic",
  "/harnessrouter",
  "/n8n",
  "/voice-studio",
  "/open-design",
  "/screenshot-to-code",
  "/wikid",
  "/omniroute",
  "/hermes-panel",
  "/hermes-agent",
  "/acestep",
];

export interface UaoServerOptions {
  readonly staticDir: string;
  readonly backendPort: number | undefined;
}

export interface UaoServerInstance {
  readonly port: number;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function isValidHost(host: string | undefined, port: number): boolean {
  if (host === undefined || host.length === 0) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isValidOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin.length === 0) return true;
  return (
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}`
  );
}

function isValidReferer(referer: string | undefined, port: number): boolean {
  if (referer === undefined || referer.length === 0) return true;
  try {
    const parsed = new URL(referer);
    return (
      parsed.origin === `http://127.0.0.1:${port}` ||
      parsed.origin === `http://localhost:${port}`
    );
  } catch {
    return false;
  }
}

function parseRequestUrl(rawUrl: string, origin: string): URL | null {
  // HTTP origin-form only. Absolute URLs, encoded nulls, and malformed URLs
  // must never turn a request boundary check into an uncaught exception.
  if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return null;
  try {
    if (decodeURIComponent(rawUrl).includes("\0")) return null;
    const parsed = new URL(rawUrl, origin);
    return parsed.origin === origin ? parsed : null;
  } catch {
    return null;
  }
}

function forwardHeaders(
  req: http.IncomingMessage,
  backendPort: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: `127.0.0.1:${backendPort}`,
    origin: `http://127.0.0.1:${backendPort}`,
  };
  if (process.env.AGENT_OS_TOKEN) {
    headers["x-agent-os-token"] = process.env.AGENT_OS_TOKEN;
  }
  return headers;
}

function writeUpgradeResponse(res: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? "Bad Gateway"}`];
  for (const [key, value] of Object.entries(res.headers)) {
    if (value !== undefined) {
      for (const item of Array.isArray(value) ? value : [value]) {
        lines.push(`${key}: ${item}`);
      }
    }
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

function isServiceWorkerRequest(
  pathname: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  if (pathname === "/sw.js" || pathname === "/service-worker.js") {
    return true;
  }
  if (headers["service-worker"] === "script") {
    return true;
  }
  return false;
}

function isDesktopPath(pathname: string): boolean {
  return (
    pathname === "/desktop" ||
    pathname === "/desktop/" ||
    pathname.startsWith("/desktop/")
  );
}

function resolveStaticRelativePath(pathname: string): string {
  if (pathname === "/desktop" || pathname === "/desktop/") {
    return "uao.html";
  }
  const subPath = pathname.slice("/desktop/".length);
  return subPath.length === 0 ? "uao.html" : subPath;
}

function isSafeUnderRoot(targetPath: string, rootDir: string): boolean {
  try {
    const realTarget = fs.realpathSync(targetPath);
    const realRoot = fs.realpathSync(rootDir);
    const rootWithSep = realRoot.endsWith(path.sep)
      ? realRoot
      : realRoot + path.sep;
    return realTarget === realRoot || realTarget.startsWith(rootWithSep);
  } catch {
    return false;
  }
}

export function matchUaoProxyRoute(pathname: string): {
  readonly matched: boolean;
  readonly isUaoApi: boolean;
  readonly backendPath: string;
} {
  if (UAO_PROXY_EXACT_PATHS.has(pathname)) {
    return {
      matched: true,
      isUaoApi: false,
      backendPath: pathname,
    };
  }

  const isUaoApi =
    pathname === "/uao-api" || pathname.startsWith("/uao-api/");
  if (isUaoApi) {
    const stripped = pathname.slice("/uao-api".length);
    const backendPath = stripped.length === 0 ? "/" : stripped;
    return {
      matched: true,
      isUaoApi: true,
      backendPath,
    };
  }

  const matchedDir = UAO_PROXY_DIR_PREFIXES.find(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (matchedDir !== undefined) {
    return {
      matched: true,
      isUaoApi: false,
      backendPath: pathname,
    };
  }

  return {
    matched: false,
    isUaoApi: false,
    backendPath: pathname,
  };
}

export function startUaoServer(
  options: UaoServerOptions,
): Promise<UaoServerInstance> {
  const backendHost = "127.0.0.1";
  const backendPort = options.backendPort ?? 5050;
  const staticDir = path.resolve(options.staticDir);
  const trackedSockets = new Set<Socket>();
  const backendAgent = new http.Agent({ keepAlive: false });

  return new Promise<UaoServerInstance>((resolveServer, rejectServer) => {
    const server = http.createServer();

    function trackSocket(socket: Socket): void {
      trackedSockets.add(socket);
      socket.once("close", () => trackedSockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    server.on("connection", trackSocket);

    server.on(
      "request",
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        const addr = server.address() as AddressInfo | null;
        const port = addr !== null ? addr.port : 0;
        const serverOrigin = `http://127.0.0.1:${port}`;

        // 1. Boundary check: Host and Origin
        if (!isValidHost(req.headers.host, port)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid Host");
          return;
        }

        if (
          !isValidOrigin(req.headers.origin, port) ||
          req.headers["sec-fetch-site"] === "cross-site"
        ) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid Origin");
          return;
        }

        if (!isValidReferer(req.headers.referer, port)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid Referer");
          return;
        }

        const parsed = parseRequestUrl(req.url ?? "/", serverOrigin);
        if (parsed === null) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Bad Request");
          return;
        }
        const pathname = parsed.pathname;
        if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method ?? "")) {
          res.writeHead(405);
          res.end("Method Not Allowed");
          return;
        }

        // 2. Prevent service worker takeover at root
        if (isServiceWorkerRequest(pathname, req.headers)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        // 3. Static renderer files under /desktop/
        if (isDesktopPath(pathname)) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405, {
              Allow: "GET, HEAD",
              "Content-Type": "text/plain",
            });
            res.end("Method Not Allowed");
            return;
          }

          const rawRelPath = resolveStaticRelativePath(pathname);
          if (rawRelPath.includes("\0")) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
            return;
          }

          let decodedRelPath: string;
          try {
            decodedRelPath = decodeURIComponent(rawRelPath);
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
            return;
          }

          if (
            path.isAbsolute(decodedRelPath) ||
            decodedRelPath.includes("\\") ||
            decodedRelPath.split("/").some((part) => part === "..")
          ) {
            res.writeHead(403);
            res.end("Not accessible");
            return;
          }
          const finalPath = path.resolve(staticDir, decodedRelPath);
          if (!isSafeUnderRoot(finalPath, staticDir)) {
            res.writeHead(fs.existsSync(finalPath) ? 403 : 404);
            res.end("Not accessible");
            return;
          }
          let stat: fs.Stats;
          try {
            stat = fs.statSync(finalPath);
          } catch {
            res.writeHead(404);
            res.end("Not Found");
            return;
          }

          if (!stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          const ext = path.extname(finalPath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const isHtml = ext === ".html";

          const headers: Record<string, string | number> = {
            "Content-Type": contentType,
            "Content-Length": stat.size,
            "Cache-Control": isHtml
              ? "no-cache"
              : "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          };

          if (isHtml) {
            headers["Content-Security-Policy"] = UAO_CONTENT_SECURITY_POLICY;
          }

          res.writeHead(200, headers);
          if (req.method === "HEAD") {
            res.end();
            return;
          }

          const stream = fs.createReadStream(finalPath);
          stream.on("error", () => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal Server Error");
            } else {
              res.destroy();
            }
          });
          res.once("close", () => stream.destroy());
          stream.pipe(res);
          return;
        }

        // 4. Bounded proxy paths to backend 5050
        const proxyRoute = matchUaoProxyRoute(pathname);
        if (!proxyRoute.matched) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        const targetBackendPath = `${proxyRoute.backendPath}${parsed.search}`;
        const headers = forwardHeaders(req, backendPort);
        delete headers.connection;

        const backendReq = http.request(
          {
            hostname: backendHost,
            port: backendPort,
            path: targetBackendPath,
            method: req.method,
            headers,
            agent: backendAgent,
          },
          (backendRes: http.IncomingMessage) => {
            const responseHeaders: http.OutgoingHttpHeaders = {
              ...backendRes.headers,
            };

            // Preserve upstream CSP only on explicitly matched proxy docs;
            // shell documents (/desktop/...) receive shell CSP.
            const fullUrl = `${serverOrigin}${pathname}${parsed.search}`;
            if (!isUaoProxyDocument(fullUrl, serverOrigin)) {
              responseHeaders["content-security-policy"] =
                UAO_CONTENT_SECURITY_POLICY;
            }

            backendRes.socket.setTimeout(0);
            backendRes.on("error", () => res.destroy());
            delete responseHeaders.connection;
            const location = responseHeaders.location;
            if (typeof location === "string") {
              try {
                const target = new URL(location, `http://${backendHost}:${backendPort}${targetBackendPath}`);
                if (target.origin === `http://${backendHost}:${backendPort}`) {
                  responseHeaders.location = `${proxyRoute.isUaoApi ? "/uao-api" : ""}${target.pathname}${target.search}${target.hash}`;
                }
              } catch {
                delete responseHeaders.location;
              }
            }
            res.writeHead(backendRes.statusCode ?? 200, responseHeaders);
            backendRes.pipe(res);
          },
        );

        backendReq.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "UAO backend unreachable",
                backend: `http://${backendHost}:${backendPort}`,
              }),
            );
          } else {
            res.destroy();
          }
        });

        backendReq.on("socket", trackSocket);
        backendReq.setTimeout(30_000, () => backendReq.destroy(new Error("Backend timeout")));
        res.once("close", () => backendReq.destroy());
        req.on("aborted", () => {
          backendReq.destroy();
        });
        req.on("error", () => {
          backendReq.destroy();
        });

        req.pipe(backendReq);
      },
    );

    // 5. Handle WebSocket Upgrades
    server.on(
      "upgrade",
      (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
        const addr = server.address() as AddressInfo | null;
        const port = addr !== null ? addr.port : 0;
        const serverOrigin = `http://127.0.0.1:${port}`;

        const parsed = parseRequestUrl(req.url ?? "/", serverOrigin);
        if (
          !isValidHost(req.headers.host, port) ||
          !isValidOrigin(req.headers.origin, port) ||
          !isValidReferer(req.headers.referer, port) ||
          req.headers["sec-fetch-site"] === "cross-site" ||
          req.method !== "GET" ||
          req.headers.upgrade?.toLowerCase() !== "websocket" ||
          parsed === null
        ) {
          socket.destroy();
          return;
        }
        const proxyRoute = matchUaoProxyRoute(parsed.pathname);
        if (!proxyRoute.matched) {
          socket.destroy();
          return;
        }

        const targetBackendPath = `${proxyRoute.backendPath}${parsed.search}`;
        const backendReq = http.request({
          hostname: backendHost,
          port: backendPort,
          path: targetBackendPath,
          method: req.method,
          headers: forwardHeaders(req, backendPort),
          agent: backendAgent,
        });
        backendReq.on("socket", trackSocket);
        backendReq.setTimeout(30_000, () => backendReq.destroy());
        socket.once("close", () => backendReq.destroy());
        backendReq.on("response", (backendRes) => {
          // A rejected upgrade must terminate instead of leaving a hanging client.
          socket.write(writeUpgradeResponse(backendRes));
          backendRes.pipe(socket);
          backendRes.once("end", () => socket.end());
          backendRes.on("error", () => socket.destroy());
        });

        backendReq.on(
          "upgrade",
          (
            backendRes: http.IncomingMessage,
            backendSocket: Socket,
            backendHead: Buffer,
          ) => {
            backendSocket.setTimeout(0);
            socket.write(writeUpgradeResponse(backendRes));
            socket.once("close", () => backendSocket.destroy());
            backendSocket.once("close", () => socket.destroy());
            if (backendHead.length > 0) {
              socket.write(backendHead);
            }
            if (head.length > 0) {
              backendSocket.write(head);
            }

            backendSocket.pipe(socket);
            socket.pipe(backendSocket);

            backendSocket.on("error", () => {
              socket.destroy();
            });
            socket.on("error", () => {
              backendSocket.destroy();
            });
          },
        );

        backendReq.on("error", () => {
          socket.destroy();
        });

        backendReq.end();
      },
    );

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null) {
        rejectServer(new Error("Failed to bind UAO runtime server address"));
        return;
      }
      const port = addr.port;
      const origin = `http://127.0.0.1:${port}`;

      resolveServer({
        port,
        origin,
        close: async () => {
          backendAgent.destroy();
          for (const s of trackedSockets) {
            s.destroy();
          }
          trackedSockets.clear();
          server.closeAllConnections();
          await new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          });
        },
      });
    });

    server.on("error", (err: unknown) => {
      rejectServer(err);
    });
  });
}
