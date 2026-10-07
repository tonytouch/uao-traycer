import { parseHttpOrigin } from "./agent-os-endpoints";

/** Expo web on Keith's Tailscale host. The URL is not a secret. */
export const OPENMUSE_DEFAULT_WEB_URL = "http://100.90.167.20:8081";
/** OpenMuse API. Hermes already listens on 8787 on this host. */
export const OPENMUSE_DEFAULT_API_URL = "http://100.90.167.20:8797";
/** Earlier builds stored the Hermes port as the OpenMuse API. */
export const OPENMUSE_RETIRED_API_URL = "http://100.90.167.20:8787";

/** Guest partition so OpenMuse storage is not the shell profile. */
export const OPENMUSE_PARTITION = "persist:openmuse";

const PROBE_TIMEOUT_MS = 4_000;
const CLIPBOARD_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
]);

export interface OpenMuseEndpointConfig {
  readonly webUrl: string;
  readonly apiUrl: string;
}

export type OpenMuseHealth =
  | { readonly status: "unconfigured"; readonly message: string }
  | {
      readonly status: "unreachable";
      readonly message: string;
      readonly webUrl: string;
      readonly apiUrl: string;
    }
  | {
      readonly status: "degraded";
      readonly message: string;
      readonly webUrl: string;
      readonly apiUrl: string;
    }
  | {
      readonly status: "ready";
      readonly message: string;
      readonly webUrl: string;
      readonly apiUrl: string;
    };

export interface OpenMuseProbeResponse {
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly json: () => Promise<unknown>;
}

export type OpenMuseProbe = (
  url: string,
  init: { readonly signal: AbortSignal } | undefined,
) => Promise<OpenMuseProbeResponse>;

export interface UaoOpenMuseApi {
  readonly getConfig: () => Promise<OpenMuseEndpointConfig>;
  readonly setConfig: (
    draft: OpenMuseEndpointConfig,
  ) => Promise<OpenMuseEndpointConfig>;
  readonly health: () => Promise<OpenMuseHealth>;
}

export function migrateOpenMuseApiUrl(url: string): string {
  return url === OPENMUSE_RETIRED_API_URL ? OPENMUSE_DEFAULT_API_URL : url;
}

export function isOpenMuseConfigured(webUrl: string): boolean {
  return webUrl.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A missing key uses the Tailscale default. A blank value stays blank so the page can hide. */
export function optionalHttpOrigin(
  stored: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  if (!Object.hasOwn(stored, key)) return fallback;
  const value = stored[key];
  if (typeof value !== "string" || value.trim() === "") return "";
  return parseHttpOrigin(value) ?? fallback;
}

export function openMuseFromStored(
  stored: Record<string, unknown> | null,
): OpenMuseEndpointConfig {
  if (stored === null) {
    return {
      webUrl: OPENMUSE_DEFAULT_WEB_URL,
      apiUrl: OPENMUSE_DEFAULT_API_URL,
    };
  }
  return {
    webUrl: optionalHttpOrigin(stored, "openmuseUrl", OPENMUSE_DEFAULT_WEB_URL),
    apiUrl: migrateOpenMuseApiUrl(
      optionalHttpOrigin(stored, "openmuseApiUrl", OPENMUSE_DEFAULT_API_URL),
    ),
  };
}

function resolveOptionalOrigin(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`${label} address is missing.`);
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const origin = parseHttpOrigin(trimmed);
  if (origin === null) {
    throw new Error(`${label} address must be an http(s) URL.`);
  }
  return origin;
}

export function resolveOpenMuseEndpoints(
  draft: unknown,
): OpenMuseEndpointConfig {
  if (!isRecord(draft)) throw new Error("Invalid OpenMuse settings.");
  return {
    webUrl: resolveOptionalOrigin(draft.webUrl, "OpenMuse web"),
    apiUrl: migrateOpenMuseApiUrl(
      resolveOptionalOrigin(draft.apiUrl, "OpenMuse API"),
    ),
  };
}

export function parseOpenMusePublicConfig(
  value: unknown,
): OpenMuseEndpointConfig {
  if (
    !isRecord(value) ||
    typeof value.webUrl !== "string" ||
    typeof value.apiUrl !== "string"
  ) {
    throw new Error("Invalid OpenMuse settings.");
  }
  if (value.webUrl !== "" && parseHttpOrigin(value.webUrl) !== value.webUrl) {
    throw new Error("Invalid OpenMuse settings.");
  }
  if (value.apiUrl !== "" && parseHttpOrigin(value.apiUrl) !== value.apiUrl) {
    throw new Error("Invalid OpenMuse settings.");
  }
  return { webUrl: value.webUrl, apiUrl: value.apiUrl };
}

export function parseOpenMuseHealth(value: unknown): OpenMuseHealth {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    typeof value.message !== "string" ||
    value.message.trim() === ""
  ) {
    throw new Error("Invalid OpenMuse status.");
  }
  const message = value.message;
  if (value.status === "unconfigured")
    return { status: "unconfigured", message };
  if (
    value.status === "unreachable" ||
    value.status === "degraded" ||
    value.status === "ready"
  ) {
    if (typeof value.webUrl !== "string" || typeof value.apiUrl !== "string") {
      throw new Error("Invalid OpenMuse status.");
    }
    return {
      status: value.status,
      message,
      webUrl: value.webUrl,
      apiUrl: value.apiUrl,
    };
  }
  throw new Error("Invalid OpenMuse status.");
}

function sameOrigin(requestOrigin: string, webOrigin: string): boolean {
  try {
    return new URL(requestOrigin).origin === new URL(webOrigin).origin;
  } catch {
    return false;
  }
}

/** Clipboard only, and only for the configured web origin. Microphone stays denied. */
export function openMusePermissionAllowed(
  permission: string,
  requestOrigin: string,
  webOrigin: string,
): boolean {
  if (webOrigin.trim() === "" || !CLIPBOARD_PERMISSIONS.has(permission)) {
    return false;
  }
  return sameOrigin(requestOrigin, webOrigin);
}

export function isAllowedOpenMuseGuestUrl(
  src: string,
  webUrl: string,
): boolean {
  const allowed = parseHttpOrigin(webUrl);
  if (allowed === null) return false;
  let target: URL;
  try {
    target = new URL(src);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (target.username !== "" || target.password !== "") return false;
  return target.origin === allowed;
}

export function decideOpenMuseAttach(input: {
  readonly src: string;
  readonly partition: string;
  readonly webUrl: string;
}): "allow" | "deny" {
  if (input.partition !== OPENMUSE_PARTITION) return "deny";
  return isAllowedOpenMuseGuestUrl(input.src, input.webUrl) ? "allow" : "deny";
}

function isOkBody(body: unknown): boolean {
  return isRecord(body) && body.ok === true;
}

async function probe(
  fetchImpl: OpenMuseProbe,
  url: string,
): Promise<
  | { readonly ok: boolean; readonly status: number; readonly body: unknown }
  | { readonly error: string }
> {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const status = response.status ?? (response.ok ? 200 : 0);
    return { ok: response.ok, status, body };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "request failed",
    };
  }
}

function probeDetail(
  result: { readonly error: string } | { readonly status: number },
): string {
  return "error" in result ? result.error : `HTTP ${result.status}`;
}

function displayUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

async function defaultProbe(
  url: string,
  init: { readonly signal: AbortSignal } | undefined,
): Promise<OpenMuseProbeResponse> {
  const response = await fetch(url, { signal: init?.signal });
  return {
    ok: response.ok,
    status: response.status,
    json: async () => {
      const body: unknown = await response.json();
      return body;
    },
  };
}

/** Web URL empty skips the network. The page's API target is baked in as EXPO_PUBLIC_API_URL. */
export async function checkOpenMuseHealth(input: {
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly fetchImpl: OpenMuseProbe | undefined;
}): Promise<OpenMuseHealth> {
  const webUrl = displayUrl(input.webUrl);
  const apiUrl = displayUrl(input.apiUrl);
  if (webUrl === "") {
    return {
      status: "unconfigured",
      message: "Set an OpenMuse web URL to show this page.",
    };
  }
  const fetchImpl = input.fetchImpl ?? defaultProbe;
  const web = await probe(fetchImpl, webUrl);
  if ("error" in web || !web.ok) {
    return {
      status: "unreachable",
      webUrl,
      apiUrl,
      message: `Unable to reach OpenMuse at ${webUrl}. ${probeDetail(web)}`,
    };
  }
  if (apiUrl === "") {
    return {
      status: "degraded",
      webUrl,
      apiUrl,
      message:
        "The web app is up. Set the OpenMuse API URL so UAO can check the server. The page calls EXPO_PUBLIC_API_URL from when it was started.",
    };
  }
  const api = await probe(fetchImpl, `${apiUrl}/api/health`);
  if ("error" in api || !api.ok || !isOkBody(api.body)) {
    return {
      status: "degraded",
      webUrl,
      apiUrl,
      message: `The web app is up, but ${apiUrl}/api/health did not report ok. The page still loads. That URL has to match EXPO_PUBLIC_API_URL.`,
    };
  }
  return {
    status: "ready",
    webUrl,
    apiUrl,
    message: "OpenMuse is reachable.",
  };
}
