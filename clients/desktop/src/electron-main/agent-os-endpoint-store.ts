import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_DEFAULT_ENDPOINTS,
  AGENT_OS_DEFAULT_HERMES_URL,
  AGENT_OS_DEFAULT_OMNIROUTE_URL,
  agentOsEmbedUrl,
  assertAgentOsToken,
  effectiveAgentOsBaseUrl,
  parseHttpOrigin,
  tailscaleCleartextOrigins,
  type AgentOsEndpointConfig,
  type AgentOsPublicConfig,
  type AgentOsTokenWriteResult,
  type UaoStoredTokenService,
} from "@traycer-clients/shared/agent-os-endpoints";

const ENDPOINT_FILE = "agent-os-endpoints.json";
const TOKEN_DIR = "agent-os-tokens";

/** Electron `safeStorage`, injected so tests never open a keychain. */
export interface AgentOsSecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(cipher: Buffer): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedOrigin(
  stored: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = stored[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return parseHttpOrigin(value) ?? fallback;
}

function endpointPath(directory: string): string {
  return join(directory, ENDPOINT_FILE);
}

function tokenPath(directory: string, service: UaoStoredTokenService): string {
  return join(directory, TOKEN_DIR, service);
}

export function readAgentOsEndpoints(directory: string): AgentOsEndpointConfig {
  const path = endpointPath(directory);
  if (!existsSync(path)) return AGENT_OS_DEFAULT_ENDPOINTS;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return AGENT_OS_DEFAULT_ENDPOINTS;
    return {
      baseUrl: storedOrigin(parsed, "baseUrl", AGENT_OS_DEFAULT_BASE_URL),
      hermesUrl: storedOrigin(parsed, "hermesUrl", AGENT_OS_DEFAULT_HERMES_URL),
      omnirouteUrl: storedOrigin(
        parsed,
        "omnirouteUrl",
        AGENT_OS_DEFAULT_OMNIROUTE_URL,
      ),
      localSupervisor: parsed.localSupervisor === true,
    };
  } catch {
    return AGENT_OS_DEFAULT_ENDPOINTS;
  }
}

export function writeAgentOsEndpoints(
  directory: string,
  config: AgentOsEndpointConfig,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = endpointPath(directory);
  const body = JSON.stringify({
    baseUrl: parseHttpOrigin(config.baseUrl) ?? AGENT_OS_DEFAULT_BASE_URL,
    hermesUrl: parseHttpOrigin(config.hermesUrl) ?? AGENT_OS_DEFAULT_HERMES_URL,
    omnirouteUrl:
      parseHttpOrigin(config.omnirouteUrl) ?? AGENT_OS_DEFAULT_OMNIROUTE_URL,
    localSupervisor: config.localSupervisor === true,
  });
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function hasAgentOsToken(
  directory: string,
  service: UaoStoredTokenService,
): boolean {
  return existsSync(tokenPath(directory, service));
}

export function readAgentOsPublicConfig(
  directory: string,
): AgentOsPublicConfig {
  const config = readAgentOsEndpoints(directory);
  return {
    ...config,
    embedUrl: agentOsEmbedUrl(effectiveAgentOsBaseUrl(config)),
    tokens: {
      "agent-os": hasAgentOsToken(directory, "agent-os"),
      hermes: hasAgentOsToken(directory, "hermes"),
      omniroute: hasAgentOsToken(directory, "omniroute"),
    },
  };
}

/**
 * Refuses to write when safeStorage cannot encrypt. The file is the ciphertext
 * only — never the token, and never a row in git.
 */
export function writeAgentOsToken(
  directory: string,
  secrets: AgentOsSecretStore,
  service: UaoStoredTokenService,
  token: string,
): AgentOsTokenWriteResult {
  const path = tokenPath(directory, service);
  const trimmed = assertAgentOsToken(token);
  if (trimmed === "") {
    rmSync(path, { force: true });
    return { ok: true };
  }
  if (!secrets.isEncryptionAvailable()) {
    return {
      ok: false,
      error: "The OS keychain is unavailable, so the token was not saved.",
    };
  }
  let sealed: Buffer;
  try {
    sealed = secrets.encryptString(trimmed);
  } catch {
    return { ok: false, error: "The token could not be saved." };
  }
  mkdirSync(join(directory, TOKEN_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(path, sealed, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true };
}

/** Main-process reads only. The renderer is told whether a token exists, not its value. */
export function readAgentOsToken(
  directory: string,
  secrets: AgentOsSecretStore,
  service: UaoStoredTokenService,
): string | null {
  const path = tokenPath(directory, service);
  if (!existsSync(path) || !secrets.isEncryptionAvailable()) return null;
  try {
    return secrets.decryptString(readFileSync(path));
  } catch {
    return null;
  }
}

/** Saved Tailscale http origins plus the built-in defaults, for one Chromium switch. */
export function collectTailscaleCleartextSwitch(
  directory: string,
  extraUrls: readonly string[],
): string {
  const saved = readAgentOsEndpoints(directory);
  return tailscaleCleartextOrigins([
    saved.baseUrl,
    saved.hermesUrl,
    saved.omnirouteUrl,
    ...extraUrls,
    AGENT_OS_DEFAULT_BASE_URL,
    AGENT_OS_DEFAULT_HERMES_URL,
    AGENT_OS_DEFAULT_OMNIROUTE_URL,
  ]);
}
