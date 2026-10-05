/**
 * Electron installs these three APIs from the preload, and the token stays in
 * safeStorage. A phone WebView has no preload. This store is the same calls
 * against `localStorage` on the page origin so Agent OS, CloudRoom, and
 * OpenMuse work after headless-serve pairing. It does not run when the
 * preload already published the APIs.
 */
import {
  AGENT_OS_DEFAULT_ENDPOINTS,
  agentOsEmbedUrl,
  assertAgentOsToken,
  effectiveAgentOsBaseUrl,
  isAgentOsTokenService,
  parseHttpOrigin,
  probeAgentOs,
  resolveAgentOsEndpoints,
  type AgentOsEndpointConfig,
  type AgentOsPublicConfig,
  type AgentOsTokenWriteResult,
  type UaoAgentOsApi,
  type UaoStoredTokenService,
} from "@traycer-clients/shared/agent-os-endpoints";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  cloudroomBaseUrlFromStored,
  createCloudroomEnvironment,
  createCloudroomRequestId,
  resolveCloudroomBaseUrl,
  type CloudroomPublicConfig,
  type UaoCloudroomApi,
} from "@traycer-clients/shared/cloudroom";
import {
  checkOpenMuseHealth,
  openMuseFromStored,
  resolveOpenMuseEndpoints,
  type OpenMuseEndpointConfig,
  type UaoOpenMuseApi,
} from "@traycer-clients/shared/openmuse";

const STORAGE_KEY = "uao.remote-pages.v1";

export interface UaoBrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UaoBrowserWindow {
  uaoAgentOs?: UaoAgentOsApi;
  uaoCloudroom?: UaoCloudroomApi;
  uaoOpenMuse?: UaoOpenMuseApi;
  localStorage: UaoBrowserStorage;
}

interface StoredRemotePages {
  agentOs?: AgentOsEndpointConfig;
  tokens?: Partial<Record<UaoStoredTokenService, string>>;
  cloudroom?: { baseUrl?: string };
  openmuse?: { openmuseUrl?: string; openmuseApiUrl?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStored(storage: UaoBrowserStorage): StoredRemotePages {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return {
      agentOs: readAgentOs(parsed.agentOs),
      tokens: readTokens(parsed.tokens),
      cloudroom: isRecord(parsed.cloudroom)
        ? { baseUrl: stringField(parsed.cloudroom.baseUrl) }
        : undefined,
      openmuse: isRecord(parsed.openmuse)
        ? {
            openmuseUrl: stringField(parsed.openmuse.openmuseUrl),
            openmuseApiUrl: stringField(parsed.openmuse.openmuseApiUrl),
          }
        : undefined,
    };
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readAgentOs(value: unknown): AgentOsEndpointConfig | undefined {
  if (!isRecord(value)) return undefined;
  const baseUrl = stringField(value.baseUrl);
  const hermesUrl = stringField(value.hermesUrl);
  const omnirouteUrl = stringField(value.omnirouteUrl);
  return {
    baseUrl:
      baseUrl === undefined
        ? AGENT_OS_DEFAULT_ENDPOINTS.baseUrl
        : (parseHttpOrigin(baseUrl) ?? AGENT_OS_DEFAULT_ENDPOINTS.baseUrl),
    hermesUrl:
      hermesUrl === undefined
        ? AGENT_OS_DEFAULT_ENDPOINTS.hermesUrl
        : (parseHttpOrigin(hermesUrl) ?? AGENT_OS_DEFAULT_ENDPOINTS.hermesUrl),
    omnirouteUrl:
      omnirouteUrl === undefined
        ? AGENT_OS_DEFAULT_ENDPOINTS.omnirouteUrl
        : (parseHttpOrigin(omnirouteUrl) ??
          AGENT_OS_DEFAULT_ENDPOINTS.omnirouteUrl),
    localSupervisor: value.localSupervisor === true,
  };
}

function readTokens(
  value: unknown,
): Partial<Record<UaoStoredTokenService, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const tokens: Partial<Record<UaoStoredTokenService, string>> = {};
  for (const service of [
    "agent-os",
    "hermes",
    "omniroute",
    "cloudroom",
  ] as const) {
    const token = value[service];
    if (typeof token === "string" && token !== "") tokens[service] = token;
  }
  return tokens;
}

function writeStored(
  storage: UaoBrowserStorage,
  stored: StoredRemotePages,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function agentOsConfig(stored: StoredRemotePages): AgentOsEndpointConfig {
  return stored.agentOs ?? AGENT_OS_DEFAULT_ENDPOINTS;
}

function publicAgentOs(stored: StoredRemotePages): AgentOsPublicConfig {
  const config = agentOsConfig(stored);
  const tokens = stored.tokens ?? {};
  return {
    ...config,
    embedUrl: agentOsEmbedUrl(effectiveAgentOsBaseUrl(config)),
    tokens: {
      "agent-os": tokens["agent-os"] !== undefined,
      hermes: tokens.hermes !== undefined,
      omniroute: tokens.omniroute !== undefined,
    },
  };
}

function cloudroomBase(stored: StoredRemotePages): string {
  if (stored.cloudroom === undefined) return CLOUDROOM_DEFAULT_BASE_URL;
  return cloudroomBaseUrlFromStored(stored.cloudroom);
}

function cloudroomConfig(stored: StoredRemotePages): CloudroomPublicConfig {
  return {
    baseUrl: cloudroomBase(stored),
    tokenSaved: stored.tokens?.cloudroom !== undefined,
  };
}

function openMuseConfig(stored: StoredRemotePages): OpenMuseEndpointConfig {
  if (stored.openmuse === undefined) return openMuseFromStored(null);
  return openMuseFromStored(stored.openmuse);
}

interface BrowserUaoApis {
  readonly agentOs: UaoAgentOsApi;
  readonly cloudroom: UaoCloudroomApi;
  readonly openmuse: UaoOpenMuseApi;
}

function tokenWrite(
  storage: UaoBrowserStorage,
  service: UaoStoredTokenService,
  token: string,
): AgentOsTokenWriteResult {
  let trimmed: string;
  try {
    trimmed = assertAgentOsToken(token);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "That token cannot be saved.";
    return { ok: false, error: message };
  }
  const stored = readStored(storage);
  const tokens = { ...(stored.tokens ?? {}) };
  if (trimmed === "") {
    delete tokens[service];
  } else {
    tokens[service] = trimmed;
  }
  try {
    writeStored(storage, { ...stored, tokens });
  } catch {
    return { ok: false, error: "The token could not be saved." };
  }
  return { ok: true };
}

function cloudroomFetch(
  fetchPage: typeof fetch,
): (input: string, init: RequestInit | undefined) => Promise<Response> {
  return (input, init) => fetchPage(input, init);
}

function openMuseProbe(fetchPage: typeof fetch): (
  url: string,
  init: { readonly signal: AbortSignal } | undefined,
) => Promise<{
  readonly ok: boolean;
  readonly status: number | undefined;
  readonly json: () => Promise<unknown>;
}> {
  return (url, init) =>
    fetchPage(url, { signal: init?.signal }).then((response) => ({
      ok: response.ok,
      status: response.status,
      json: async () => {
        const body: unknown = await response.json();
        return body;
      },
    }));
}

export function createBrowserUaoApis(
  storage: UaoBrowserStorage,
  fetchPage: typeof fetch,
): BrowserUaoApis {
  const agentOs: UaoAgentOsApi = {
    getConfig: () => Promise.resolve(publicAgentOs(readStored(storage))),
    setConfig: (draft) => {
      const stored = readStored(storage);
      const next = resolveAgentOsEndpoints(agentOsConfig(stored), draft);
      writeStored(storage, { ...stored, agentOs: next });
      return Promise.resolve(publicAgentOs(readStored(storage)));
    },
    setToken: (service, token) => {
      if (!isAgentOsTokenService(service)) {
        return Promise.resolve({ ok: false, error: "Unknown token." });
      }
      return Promise.resolve(tokenWrite(storage, service, token));
    },
    probe: () => {
      const config = agentOsConfig(readStored(storage));
      return probeAgentOs(effectiveAgentOsBaseUrl(config), fetchPage);
    },
  };

  const cloudroomAt = () => {
    const stored = readStored(storage);
    return createCloudroomEnvironment({
      baseUrl: cloudroomBase(stored),
      token: stored.tokens?.cloudroom ?? "",
      fetchImpl: cloudroomFetch(fetchPage),
      requestId: () => createCloudroomRequestId(globalThis.crypto.randomUUID()),
    });
  };
  const cloudroom: UaoCloudroomApi = {
    getConfig: () => Promise.resolve(cloudroomConfig(readStored(storage))),
    setConfig: (draft) => {
      const baseUrl = resolveCloudroomBaseUrl(draft);
      const stored = readStored(storage);
      writeStored(storage, { ...stored, cloudroom: { baseUrl } });
      return Promise.resolve(cloudroomConfig(readStored(storage)));
    },
    setToken: (token) =>
      Promise.resolve(tokenWrite(storage, "cloudroom", token)),
    health: () => cloudroomAt().health(),
    listSessions: () => cloudroomAt().listSessions(),
    createSession: (input) => cloudroomAt().createSession(input),
    events: (sessionId, after) => cloudroomAt().events(sessionId, after),
  };

  const openmuse: UaoOpenMuseApi = {
    getConfig: () => Promise.resolve(openMuseConfig(readStored(storage))),
    setConfig: (draft) => {
      const next = resolveOpenMuseEndpoints(draft);
      const stored = readStored(storage);
      writeStored(storage, {
        ...stored,
        openmuse: { openmuseUrl: next.webUrl, openmuseApiUrl: next.apiUrl },
      });
      return Promise.resolve(openMuseConfig(readStored(storage)));
    },
    health: () => {
      const config = openMuseConfig(readStored(storage));
      return checkOpenMuseHealth({
        webUrl: config.webUrl,
        apiUrl: config.apiUrl,
        fetchImpl: openMuseProbe(fetchPage),
      });
    },
  };

  return { agentOs, cloudroom, openmuse };
}

export function installBrowserUaoApis(target: UaoBrowserWindow): void {
  if (
    target.uaoAgentOs !== undefined &&
    target.uaoCloudroom !== undefined &&
    target.uaoOpenMuse !== undefined
  ) {
    return;
  }
  let apis: BrowserUaoApis;
  try {
    apis = createBrowserUaoApis(target.localStorage, globalThis.fetch);
  } catch {
    return;
  }
  if (target.uaoAgentOs === undefined) target.uaoAgentOs = apis.agentOs;
  if (target.uaoCloudroom === undefined) target.uaoCloudroom = apis.cloudroom;
  if (target.uaoOpenMuse === undefined) target.uaoOpenMuse = apis.openmuse;
}
