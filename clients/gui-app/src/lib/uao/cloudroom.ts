import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  mergeCloudroomEvents,
  type UaoCloudroomApi,
} from "@traycer-clients/shared/cloudroom";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

export interface CloudroomTranscriptSnapshot {
  readonly cursor: number;
  readonly text: string;
  readonly error: string | null;
}

declare global {
  interface Window {
    uaoCloudroom?: UaoCloudroomApi;
  }
}

export function getCloudroomApi(): UaoCloudroomApi {
  const api = window.uaoCloudroom;
  if (api === undefined) {
    throw new Error("CloudRoom is available in the UAO shell.");
  }
  return api;
}

export function cloudroomConfigQueryOptions() {
  return queryOptions({
    queryKey: uaoQueryKeys.cloudroomConfig(),
    queryFn: () => getCloudroomApi().getConfig(),
    retry: false,
  });
}

export function cloudroomHealthQueryOptions(
  baseUrl: string,
  tokenSaved: boolean,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: uaoQueryKeys.cloudroomHealth(baseUrl, tokenSaved),
    queryFn: enabled ? () => getCloudroomApi().health() : skipToken,
    retry: false,
  });
}

export function cloudroomSessionsQueryOptions(
  baseUrl: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: uaoQueryKeys.cloudroomSessions(baseUrl),
    queryFn: enabled ? () => getCloudroomApi().listSessions() : skipToken,
    retry: false,
  });
}

/** One cache row per session. Each poll continues after the cursor already stored there. */
export function cloudroomEventsQueryOptions(sessionId: string) {
  const queryKey = uaoQueryKeys.cloudroomEvents(sessionId);
  return queryOptions({
    queryKey,
    retry: false,
    refetchInterval: 2000,
    queryFn: async ({ client, queryKey: activeKey }) => {
      const previous =
        client.getQueryData<CloudroomTranscriptSnapshot>(activeKey);
      const after = previous?.cursor ?? 0;
      const text = previous?.text ?? "";
      const result = await getCloudroomApi().events(sessionId, after);
      if (!result.ok) {
        const failed: CloudroomTranscriptSnapshot = {
          cursor: after,
          text,
          error: result.error,
        };
        return failed;
      }
      const absorbed = mergeCloudroomEvents(after, text, result.value);
      const next: CloudroomTranscriptSnapshot = {
        cursor: absorbed.cursor,
        text: absorbed.text,
        error: null,
      };
      return next;
    },
  });
}
