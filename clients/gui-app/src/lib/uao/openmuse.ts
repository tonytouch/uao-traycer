import { queryOptions, skipToken } from "@tanstack/react-query";
import type { UaoOpenMuseApi } from "@traycer-clients/shared/openmuse";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

declare global {
  interface Window {
    uaoOpenMuse?: UaoOpenMuseApi;
  }
}

export function getOpenMuseApi(): UaoOpenMuseApi {
  const api = window.uaoOpenMuse;
  if (api === undefined) {
    throw new Error("OpenMuse is available in the UAO shell.");
  }
  return api;
}

export function openmuseConfigQueryOptions() {
  return queryOptions({
    queryKey: uaoQueryKeys.openmuseConfig(),
    queryFn: () => getOpenMuseApi().getConfig(),
    retry: false,
  });
}

export function openmuseHealthQueryOptions(
  webUrl: string,
  apiUrl: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: uaoQueryKeys.openmuseHealth(webUrl, apiUrl),
    queryFn: enabled ? () => getOpenMuseApi().health() : skipToken,
    retry: false,
  });
}
