import { queryOptions } from "@tanstack/react-query";
import type { UaoOfficeApi } from "@traycer-clients/shared/uao-office";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
declare global {
  interface Window {
    readonly uaoOffice?: UaoOfficeApi;
  }
}
export function getOfficeApi(): UaoOfficeApi {
  if (!window.uaoOffice) throw new Error("Office is available in the packaged UAO desktop.");
  return window.uaoOffice;
}
export function officeQueryOptions() {
  return queryOptions({ queryKey: uaoQueryKeys.office(),
    queryFn: () => getOfficeApi().list(), retry: false });
}
