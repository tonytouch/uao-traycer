import { useEffect, useRef } from "react";

export interface UaoEndpointsReport {
  readonly expanded: boolean;
  readonly label: string;
  readonly toggle: () => void;
}

/** The Agents hub owns the one Endpoints button and each tab reports into it. */
export interface UaoEndpointsChrome {
  readonly report: (state: UaoEndpointsReport) => void;
}

export function endpointsChromeLabel(expanded: boolean): string {
  return expanded ? "Hide endpoints" : "Endpoints";
}

export function useReportEndpointsChrome(
  chrome: UaoEndpointsChrome | null,
  expanded: boolean,
  label: string,
  toggle: () => void,
): void {
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);
  const report = chrome === null ? undefined : chrome.report;
  useEffect(() => {
    if (report === undefined) return;
    report({
      expanded,
      label,
      toggle: () => {
        toggleRef.current();
      },
    });
  }, [report, expanded, label]);
}
