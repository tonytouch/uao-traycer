/** Tailscale addresses for Keith's Agent OS host. URLs are not secrets. */

export const AGENT_OS_DEFAULT_BASE_URL = "http://100.90.167.20:5050";
export const AGENT_OS_DEFAULT_HERMES_URL = "http://100.90.167.20:8787";
export const AGENT_OS_DEFAULT_OMNIROUTE_URL = "http://100.90.167.20:20128";
/** Used only when the Endpoints form opts into a backend already running here. */
export const AGENT_OS_LOCAL_BASE_URL = "http://127.0.0.1:5050";

/** Guest partition so the remote page does not inherit the shell Content-Security-Policy. */
export const AGENT_OS_WEBVIEW_PARTITION = "persist:uao-agent-os";

export const AGENT_OS_TOKEN_SERVICES = [
  "agent-os",
  "hermes",
  "omniroute",
] as const;
export type AgentOsTokenService = (typeof AGENT_OS_TOKEN_SERVICES)[number];

/** Same on-disk token directory as Phase 1. CloudRoom is a file in that directory. */
export const UAO_STORED_TOKEN_SERVICES = [
  ...AGENT_OS_TOKEN_SERVICES,
  "cloudroom",
] as const;
export type UaoStoredTokenService = (typeof UAO_STORED_TOKEN_SERVICES)[number];

export interface AgentOsEndpointConfig {
  readonly baseUrl: string;
  readonly hermesUrl: string;
  readonly omnirouteUrl: string;
  /** When true, the page attaches to 127.0.0.1:5050 and does not spawn a backend. */
  readonly localSupervisor: boolean;
}

export interface AgentOsPublicConfig extends AgentOsEndpointConfig {
  readonly embedUrl: string;
  readonly tokens: Readonly<Record<AgentOsTokenService, boolean>>;
}

export type AgentOsProbe =
  | { readonly ok: true; readonly error: null }
  | { readonly ok: false; readonly error: string };

export type AgentOsTokenWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface UaoAgentOsApi {
  readonly getConfig: () => Promise<AgentOsPublicConfig>;
  readonly setConfig: (
    draft: AgentOsEndpointConfig,
  ) => Promise<AgentOsPublicConfig>;
  readonly setToken: (
    service: AgentOsTokenService,
    token: string,
  ) => Promise<AgentOsTokenWriteResult>;
  readonly probe: () => Promise<AgentOsProbe>;
}

export const AGENT_OS_DEFAULT_ENDPOINTS: AgentOsEndpointConfig = {
  baseUrl: AGENT_OS_DEFAULT_BASE_URL,
  hermesUrl: AGENT_OS_DEFAULT_HERMES_URL,
  omnirouteUrl: AGENT_OS_DEFAULT_OMNIROUTE_URL,
  localSupervisor: false,
};

const TOKEN_LENGTH_LIMIT = 4096;

export function isAgentOsTokenService(
  value: unknown,
): value is AgentOsTokenService {
  return AGENT_OS_TOKEN_SERVICES.some((service) => service === value);
}

export function isUaoStoredTokenService(
  value: unknown,
): value is UaoStoredTokenService {
  return UAO_STORED_TOKEN_SERVICES.some((service) => service === value);
}

/** 100.64.0.0/10 — Tailscale CGNAT, not a general private range. */
export function isTailscaleCgnatHost(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "100") return false;
  const second = parts[1];
  const third = parts[2];
  const fourth = parts[3];
  if (second === undefined || third === undefined || fourth === undefined)
    return false;
  if (
    !/^\d{1,3}$/.test(second) ||
    !/^\d{1,3}$/.test(third) ||
    !/^\d{1,3}$/.test(fourth)
  ) {
    return false;
  }
  const secondOctet = Number(second);
  const thirdOctet = Number(third);
  const fourthOctet = Number(fourth);
  if (secondOctet > 255 || thirdOctet > 255 || fourthOctet > 255) return false;
  return secondOctet >= 64 && secondOctet <= 127;
}

/** Origin only. Credentials, paths, and non-http schemes are rejected. */
export function parseHttpOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return url.origin;
}

export function effectiveAgentOsBaseUrl(config: AgentOsEndpointConfig): string {
  return config.localSupervisor ? AGENT_OS_LOCAL_BASE_URL : config.baseUrl;
}

/** Remote Agent OS hides its own shell when `embed=1` is set. Hash matches the Orca page. */
export function agentOsEmbedUrl(baseUrl: string): string {
  const origin = parseHttpOrigin(baseUrl) ?? AGENT_OS_DEFAULT_BASE_URL;
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "embed=1";
  url.hash = "overview";
  return url.href;
}

export function isAllowedAgentOsGuestUrl(
  src: string,
  allowedBaseUrl: string,
): boolean {
  const allowed = parseHttpOrigin(allowedBaseUrl);
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

export function decideAgentOsAttach(input: {
  readonly src: string;
  readonly partition: string;
  readonly allowedBaseUrl: string;
}): "allow" | "deny" {
  if (input.partition !== AGENT_OS_WEBVIEW_PARTITION) return "deny";
  return isAllowedAgentOsGuestUrl(input.src, input.allowedBaseUrl)
    ? "allow"
    : "deny";
}

/** Comma-separated origins for Chromium's insecure-origin switch. Http + 100.64/10 only. */
export function tailscaleCleartextOrigins(urls: readonly string[]): string {
  const origins = new Set<string>();
  for (const candidate of urls) {
    const origin = parseHttpOrigin(candidate);
    if (origin === null) continue;
    const url = new URL(origin);
    if (url.protocol !== "http:") continue;
    if (!isTailscaleCgnatHost(url.hostname)) continue;
    origins.add(origin);
  }
  return [...origins].join(",");
}

export function assertAgentOsToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length > TOKEN_LENGTH_LIMIT) {
    throw new Error("That token is too long to save.");
  }
  if (/[\u0000\r\n]/.test(trimmed)) {
    throw new Error("That token cannot be saved.");
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredOrigin(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label} address.`);
  const origin = parseHttpOrigin(value);
  if (origin === null) throw new Error(`Invalid ${label} address.`);
  return origin;
}

function parseTokenFlags(value: unknown): Record<AgentOsTokenService, boolean> {
  const record = isRecord(value) ? value : {};
  return {
    "agent-os": record["agent-os"] === true,
    hermes: record.hermes === true,
    omniroute: record.omniroute === true,
  };
}

/** Recomputes the embed URL from the validated origins so the wire value cannot point elsewhere. */
export function parseAgentOsPublicConfig(value: unknown): AgentOsPublicConfig {
  if (!isRecord(value)) throw new Error("Invalid Agent OS settings.");
  const config: AgentOsEndpointConfig = {
    baseUrl: requiredOrigin(value.baseUrl, "Agent OS"),
    hermesUrl: requiredOrigin(value.hermesUrl, "Hermes"),
    omnirouteUrl: requiredOrigin(value.omnirouteUrl, "Omniroute"),
    localSupervisor: value.localSupervisor === true,
  };
  return {
    ...config,
    embedUrl: agentOsEmbedUrl(effectiveAgentOsBaseUrl(config)),
    tokens: parseTokenFlags(value.tokens),
  };
}

export function parseAgentOsProbe(value: unknown): AgentOsProbe {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid Agent OS status.");
  }
  if (value.ok) return { ok: true, error: null };
  if (typeof value.error !== "string" || value.error.trim() === "") {
    throw new Error("Invalid Agent OS status.");
  }
  return { ok: false, error: value.error };
}

export function parseAgentOsTokenWrite(
  value: unknown,
): AgentOsTokenWriteResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid token result.");
  }
  if (value.ok) return { ok: true };
  if (typeof value.error !== "string" || value.error.trim() === "") {
    throw new Error("Invalid token result.");
  }
  return { ok: false, error: value.error };
}

function resolveOriginField(
  value: unknown,
  fallback: string,
  label: string,
): string {
  if (typeof value !== "string")
    throw new Error(`${label} address is missing.`);
  if (value.trim() === "") return fallback;
  const origin = parseHttpOrigin(value);
  if (origin === null)
    throw new Error(`${label} address must be an http(s) URL.`);
  return origin;
}

export function resolveAgentOsEndpoints(
  current: AgentOsEndpointConfig,
  draft: unknown,
): AgentOsEndpointConfig {
  if (!isRecord(draft)) throw new Error("Invalid Agent OS settings.");
  return {
    baseUrl: resolveOriginField(draft.baseUrl, current.baseUrl, "Agent OS"),
    hermesUrl: resolveOriginField(draft.hermesUrl, current.hermesUrl, "Hermes"),
    omnirouteUrl: resolveOriginField(
      draft.omnirouteUrl,
      current.omnirouteUrl,
      "Omniroute",
    ),
    localSupervisor: draft.localSupervisor === true,
  };
}

async function cancelUnread(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // The status is the probe result. Failing to cancel the body is not the outage.
  }
}

/** GET `/` on the effective origin. `/healthz` is not required; the live host answers `/`. */
export async function probeAgentOs(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<AgentOsProbe> {
  const origin = parseHttpOrigin(baseUrl);
  if (origin === null) {
    return { ok: false, error: "Agent OS address is not an http(s) URL." };
  }
  const target = `${origin}/`;
  try {
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(4000),
    });
    await cancelUnread(response);
    if (response.ok || (response.status >= 300 && response.status < 400)) {
      return { ok: true, error: null };
    }
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Agent OS could not be reached.";
    return { ok: false, error: message };
  }
}
