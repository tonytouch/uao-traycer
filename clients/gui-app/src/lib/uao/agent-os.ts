import { queryOptions, skipToken } from "@tanstack/react-query";
import type { UaoAgentOsApi } from "@traycer-clients/shared/agent-os-endpoints";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

declare global {
  interface Window {
    uaoAgentOs?: UaoAgentOsApi;
  }
}

export function getAgentOsApi(): UaoAgentOsApi {
  const api = window.uaoAgentOs;
  if (api === undefined) {
    throw new Error("Agent OS is available in the UAO desktop.");
  }
  return api;
}

export function agentOsConfigQueryOptions() {
  return queryOptions({
    queryKey: uaoQueryKeys.agentOsConfig(),
    queryFn: () => getAgentOsApi().getConfig(),
    retry: false,
  });
}

export function agentOsProbeQueryOptions(embedUrl: string, enabled: boolean) {
  return queryOptions({
    queryKey: uaoQueryKeys.agentOsProbe(embedUrl),
    queryFn: enabled ? () => getAgentOsApi().probe() : skipToken,
    retry: false,
  });
}
