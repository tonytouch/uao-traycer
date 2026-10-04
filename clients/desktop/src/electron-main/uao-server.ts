import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import {
  UAO_CONTENT_SECURITY_POLICY,
  isUaoProxyDocument,
} from "../shared/content-security-policy";
import {
  handleOrcaHttpRequest,
  handleOrcaTerminalStreamUpgrade,
} from "./uao-orca-adapter";

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
  readonly port?: number;
  /** Interface to bind. Defaults to loopback; anything else needs `pairingSecret`. */
  readonly host?: string;
  /**
   * Extra browser origins (scheme + host[:port], no path) allowed in the
   * Host/Origin/Referer boundary checks, e.g. a tailnet HTTPS origin.
   * Requires `pairingSecret`.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * When set, every request except `GET /uao-pair?token=...` must carry the
   * pairing cookie or the `x-uao-pairing` header. At least 32 characters.
   */
  readonly pairingSecret?: string;
  /**
   * Serve the Orca terminal routes (`/uao-api/orca/*`). They run local
   * processes, so remote deployments should turn them off. Default true.
   */
  readonly orca?: boolean;
}

export const UAO_PAIR_PATH = "/uao-pair";
export const UAO_PAIR_COOKIE = "uao_pair";
export const UAO_PAIR_HEADER = "x-uao-pairing";
export const UAO_PAIRING_SECRET_MIN_LENGTH = 32;
/**
 * The Android shell's launcher page lives on another origin and hands off with
 * a top-level navigation, which browsers label `Sec-Fetch-Site: cross-site`.
 * Only these two paths may be loaded that way: the pairing hand-off and the
 * static shell it redirects to (the redirect keeps the cross-site label).
 */
const CROSS_SITE_NAVIGATION_PATHS: ReadonlySet<string> = new Set([
  UAO_PAIR_PATH,
  "/desktop/uao.html",
]);
const PAIR_FAILURE_LIMIT = 10;
const PAIR_FAILURE_WINDOW_MS = 60_000;

export interface UaoServerInstance {
  readonly port: number;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

// Before UAO's module starts, share only its common dashboard activity feed.
// Other EventSource URLs (tool-specific streams) retain their native behavior.
const FRAME_BOOTSTRAP = `<script>
(() => {
  const NativeSource = window.EventSource;
  window.EventSource = class extends NativeSource {
    constructor(url, options) {
      const target = new URL(url, location.href);
      if (target.origin === location.origin && target.pathname === '/api/agents/activity'
          && !target.search && !options?.withCredentials && parent.__uaoActivitySource) {
        return new parent.__uaoActivitySource();
      }
      super(url, options);
    }
  };
})();
</script>`;

/** Opt-in shell documents only. Preserve the backend's URL, CSP and assets. */
export async function handleUaoFrameDocument(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  backendPort: number,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (
    req.method !== "GET" ||
    url.pathname !== "/uao-api/" ||
    url.searchParams.get("desktop-frame") !== "1"
  ) return false;

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/${url.search}`, {
      headers: {
        Accept: "text/html",
        ...(process.env.AGENT_OS_TOKEN
          ? { "x-agent-os-token": process.env.AGENT_OS_TOKEN }
          : {}),
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error("UAO document too large");
        }
        chunks.push(chunk.value);
      }
    }
    let html = Buffer.concat(chunks).toString("utf8");
    if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
      html = html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + FRAME_BOOTSTRAP);
    }
    const headers = Object.fromEntries(response.headers);
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    delete headers.etag;
    res.writeHead(response.status, {
      ...headers,
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("UAO interface unavailable");
  } finally {
    res.removeListener("close", abort);
  }
  return true;
}

interface BoundaryAllowList {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
}

function buildAllowList(
  port: number,
  extraOrigins: readonly string[],
): BoundaryAllowList {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  for (const origin of extraOrigins) {
    origins.add(origin);
    hosts.add(new URL(origin).host);
  }
  return { hosts, origins };
}

function isValidHost(
  host: string | undefined,
  allow: BoundaryAllowList,
): boolean {
  if (host === undefined || host.length === 0) return false;
  return allow.hosts.has(host);
}

function isValidOrigin(
  origin: string | undefined,
  allow: BoundaryAllowList,
): boolean {
  if (origin === undefined || origin.length === 0) return true;
  return allow.origins.has(origin);
}

function isValidReferer(
  referer: string | undefined,
  allow: BoundaryAllowList,
): boolean {
  if (referer === undefined || referer.length === 0) return true;
  try {
    return allow.origins.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

function isCrossSiteNavigationAllowed(req: http.IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (
    req.headers["sec-fetch-mode"] !== "navigate" ||
    req.headers["sec-fetch-dest"] !== "document"
  ) {
    return false;
  }
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  return CROSS_SITE_NAVIGATION_PATHS.has(pathname);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Normalises and validates `allowedOrigins`; throws on anything but origin-only http(s). */
function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  return origins.map((raw) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid allowed origin: ${raw}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error(`Allowed origin must be scheme://host[:port]: ${raw}`);
    }
    return parsed.origin;
  });
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Cookie value derived from the secret, so the raw secret never sits in the cookie jar. */
function pairingSessionToken(secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("uao-pairing-session-v1")
    .digest("hex");
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
  // Pairing credentials stop at this proxy, and client-asserted network
  // identity must not reach a backend that trusts such headers.
  delete headers[UAO_PAIR_HEADER];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  delete headers.forwarded;
  // `tailscale serve` adds identity headers (tailscale-user-login, ...). The
  // backend counts tailscale-user-login as a forwarding header and then
  // refuses the loopback exemption, so none of them may pass through.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith("tailscale-")) delete headers[name];
  }
  if (typeof headers.cookie === "string") {
    const kept = headers.cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => !part.startsWith(`${UAO_PAIR_COOKIE}=`));
    if (kept.length > 0) headers.cookie = kept.join("; ");
    else delete headers.cookie;
  }
  if (process.env.AGENT_OS_TOKEN) {
    headers["x-agent-os-token"] = process.env.AGENT_OS_TOKEN;
  }
  return headers;
}

function writeUpgradeResponse(res: http.IncomingMessage): string {
  const lines = [
    `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? "Bad Gateway"}`,
  ];
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

  const isUaoApi = pathname === "/uao-api" || pathname.startsWith("/uao-api/");
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
  const bindHost = options.host ?? "127.0.0.1";
  const orcaEnabled = options.orca !== false;
  const pairingSecret = options.pairingSecret;

  let extraOrigins: string[];
  try {
    extraOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    pairingSecret === undefined &&
    (!isLoopbackHost(bindHost) || extraOrigins.length > 0)
  ) {
    return Promise.reject(
      new Error(
        "A pairing secret is required when binding a non-loopback host or allowing extra origins.",
      ),
    );
  }
  if (
    pairingSecret !== undefined &&
    pairingSecret.length < UAO_PAIRING_SECRET_MIN_LENGTH
  ) {
    return Promise.reject(
      new Error(
        `The pairing secret must be at least ${UAO_PAIRING_SECRET_MIN_LENGTH} characters.`,
      ),
    );
  }
  const sessionToken =
    pairingSecret === undefined ? null : pairingSessionToken(pairingSecret);
  const pairFailures = new Map<string, { count: number; resetAt: number }>();

  function pairingThrottled(remote: string | undefined): boolean {
    const entry = pairFailures.get(remote ?? "");
    if (entry === undefined) return false;
    if (Date.now() >= entry.resetAt) {
      pairFailures.delete(remote ?? "");
      return false;
    }
    return entry.count >= PAIR_FAILURE_LIMIT;
  }

  function recordPairFailure(remote: string | undefined): void {
    const key = remote ?? "";
    const now = Date.now();
    const entry = pairFailures.get(key);
    if (entry === undefined || now >= entry.resetAt) {
      pairFailures.set(key, {
        count: 1,
        resetAt: now + PAIR_FAILURE_WINDOW_MS,
      });
    } else {
      entry.count += 1;
    }
  }

  /** "ok", "missing" (no credential), or "bad" (a credential that did not match). */
  function checkPairing(req: http.IncomingMessage): "ok" | "missing" | "bad" {
    if (pairingSecret === undefined || sessionToken === null) return "ok";
    const header = req.headers[UAO_PAIR_HEADER];
    if (typeof header === "string" && header.length > 0) {
      return safeEqual(header, pairingSecret) ? "ok" : "bad";
    }
    const cookie = readCookie(req.headers.cookie, UAO_PAIR_COOKIE);
    if (cookie === null) return "missing";
    return safeEqual(cookie, sessionToken) ? "ok" : "missing";
  }

  function handlePairRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsed: URL,
    allow: BoundaryAllowList,
  ): void {
    const remote = req.socket.remoteAddress;
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET", "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    if (pairingThrottled(remote)) {
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "60" });
      res.end("Too many pairing attempts");
      return;
    }
    const token = parsed.searchParams.get("token") ?? "";
    if (
      pairingSecret === undefined ||
      sessionToken === null ||
      !safeEqual(token, pairingSecret)
    ) {
      recordPairFailure(remote);
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Pairing failed");
      return;
    }
    pairFailures.delete(remote ?? "");
    const hostHeader = req.headers.host ?? "";
    const secure = [...allow.origins].some(
      (origin) =>
        origin.startsWith("https://") && new URL(origin).host === hostHeader,
    );
    res.writeHead(303, {
      Location: "/desktop/uao.html",
      "Set-Cookie": `${UAO_PAIR_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
  }
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
        const allow = buildAllowList(port, extraOrigins);

        // 1. Boundary check: Host and Origin
        if (!isValidHost(req.headers.host, allow)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid Host");
          return;
        }

        const crossSiteNavigation =
          pairingSecret !== undefined && isCrossSiteNavigationAllowed(req);
        if (
          !isValidOrigin(req.headers.origin, allow) ||
          (req.headers["sec-fetch-site"] === "cross-site" &&
            !crossSiteNavigation)
        ) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid Origin");
          return;
        }

        if (!crossSiteNavigation && !isValidReferer(req.headers.referer, allow)) {
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
        if (
          ![
            "GET",
            "HEAD",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
          ].includes(req.method ?? "")
        ) {
          res.writeHead(405);
          res.end("Method Not Allowed");
          return;
        }

        // 1b. Pairing gate: nothing past this point is reachable unpaired.
        if (pairingSecret !== undefined && pathname === UAO_PAIR_PATH) {
          handlePairRequest(req, res, parsed, allow);
          return;
        }
        const pairing = checkPairing(req);
        if (pairing !== "ok") {
          if (pairing === "bad") recordPairFailure(req.socket.remoteAddress);
          res.writeHead(401, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          });
          res.end("Pairing required");
          return;
        }

        // 2. Prevent service worker takeover at root
        if (isServiceWorkerRequest(pathname, req.headers)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        // 2b. Direct bounded Orca CLI adapter
        if (
          pathname === "/uao-api/orca" ||
          pathname.startsWith("/uao-api/orca/")
        ) {
          if (!orcaEnabled) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }
          void handleOrcaHttpRequest(req, res, {
            port,
            serverOrigin,
            parsedUrl: parsed,
          }).catch(() => {
            if (!res.headersSent)
              res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ ok: false, error: "Orca request failed" }),
            );
          });
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
        if (
          req.method === "GET" && pathname === "/uao-api/" &&
          parsed.searchParams.get("desktop-frame") === "1"
        ) {
          void handleUaoFrameDocument(req, res, backendPort);
          return;
        }

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
                const target = new URL(
                  location,
                  `http://${backendHost}:${backendPort}${targetBackendPath}`,
                );
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
        backendReq.setTimeout(30_000, () =>
          backendReq.destroy(new Error("Backend timeout")),
        );
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
        const allow = buildAllowList(port, extraOrigins);

        const parsed = parseRequestUrl(req.url ?? "/", serverOrigin);
        if (
          !isValidHost(req.headers.host, allow) ||
          !isValidOrigin(req.headers.origin, allow) ||
          !isValidReferer(req.headers.referer, allow) ||
          req.headers["sec-fetch-site"] === "cross-site" ||
          req.method !== "GET" ||
          req.headers.upgrade?.toLowerCase() !== "websocket" ||
          parsed === null
        ) {
          socket.destroy();
          return;
        }

        const pairing = checkPairing(req);
        if (pairing !== "ok") {
          if (pairing === "bad") recordPairFailure(req.socket.remoteAddress);
          socket.end(
            "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
          return;
        }

        if (parsed.pathname === "/uao-api/orca/terminal/stream") {
          if (!orcaEnabled) {
            socket.destroy();
            return;
          }
          void handleOrcaTerminalStreamUpgrade(req, socket, head, {
            port,
            serverOrigin,
            parsedUrl: parsed,
            userDataPath: undefined,
            subscribeRuntimeImpl: undefined,
          }).catch(() => {
            socket.destroy();
          });
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

    server.listen(options.port ?? 0, bindHost, () => {
      const addr = server.address() as AddressInfo | null;
      if (addr === null) {
        rejectServer(new Error("Failed to bind UAO runtime server address"));
        return;
      }
      const port = addr.port;
      const origin = `http://${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${port}`;

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
