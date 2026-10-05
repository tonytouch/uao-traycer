import { useSyncExternalStore } from "react";

/**
 * Which machine's Orca the workspaces and agent terminals talk to: this
 * computer's (`local`) or the one behind the desktop's upstream gateway
 * (`server`). The target is a path prefix on the desktop's own origin; its
 * proxy rewrites the `server` prefix and the renderer never sees the secret.
 */
export type OrcaTarget = "local" | "server";

const STORAGE_KEY = "uao.orca.target";
const listeners = new Set<() => void>();
let current: OrcaTarget = readStored();

function readStored(): OrcaTarget {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "server"
      ? "server"
      : "local";
  } catch {
    return "local";
  }
}

export function getOrcaTarget(): OrcaTarget {
  return current;
}

export function setOrcaTarget(target: OrcaTarget): void {
  if (target === current) return;
  current = target;
  try {
    window.localStorage.setItem(STORAGE_KEY, target);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  for (const listener of listeners) listener();
}

export function orcaApiPrefix(target: OrcaTarget = current): string {
  return target === "server" ? "/uao-api/orca-server" : "/uao-api/orca";
}

export function useOrcaTarget(): OrcaTarget {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOrcaTarget,
    () => "local",
  );
}
