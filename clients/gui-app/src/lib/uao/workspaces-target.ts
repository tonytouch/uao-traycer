import { useSyncExternalStore } from "react";

/**
 * Which machine's Workspace the workspaces and agent terminals talk to: this
 * computer's (`local`) or the one behind the desktop's upstream gateway
 * (`server`). The target is a path prefix on the desktop's own origin; its
 * proxy rewrites the `server` prefix and the renderer never sees the secret.
 */
export type WorkspaceTarget = "local" | "server";

const STORAGE_KEY = "uao.workspaces.target";
const listeners = new Set<() => void>();
let current: WorkspaceTarget = readStored();

function readStored(): WorkspaceTarget {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "server"
      ? "server"
      : "local";
  } catch {
    return "local";
  }
}

export function getWorkspaceTarget(): WorkspaceTarget {
  return current;
}

export function setWorkspaceTarget(target: WorkspaceTarget): void {
  if (target === current) return;
  current = target;
  try {
    window.localStorage.setItem(STORAGE_KEY, target);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  for (const listener of listeners) listener();
}

export function workspaceApiPrefix(target: WorkspaceTarget): string {
  return target === "server" ? "/uao-api/workspaces-server" : "/uao-api/workspaces";
}

export function useWorkspaceTarget(): WorkspaceTarget {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getWorkspaceTarget,
    () => "local",
  );
}
