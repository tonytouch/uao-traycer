import {
  ALL_NAV_PANES,
  DEFAULT_PANE_ID,
  getFeatureOwnerId,
  isFeatureOwner,
  isValidNavPaneId,
  WORKSPACE_PANE_ID,
} from "./uao-nav-registry";

export interface UaoWorktab {
  readonly ownerId: string;
  readonly routeTarget: string;
}

export interface PersistedWorktabsState {
  readonly tabs: readonly UaoWorktab[];
  readonly activeOwnerId: string;
  readonly activeRouteId: string;
}

// One tab per known feature. Opening another feature must never evict work.
export const MAX_WORKTABS = ALL_NAV_PANES.filter((pane) =>
  isFeatureOwner(pane.id),
).length;
export const WORKTABS_STORAGE_KEY = "uao_worktabs_state_v1";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "uao_sidebar_collapsed_v1";
export const WORKSPACE_LAYOUT_STORAGE_KEY = "uao_workspace_layout_v1";

export const DEFAULT_3PANE_SIZES: readonly [number, number, number] = [
  0.25, 0.45, 0.3,
];
export const DEFAULT_2PANE_SIZES: readonly [number, number] = [0.3, 0.7];
export const MIN_PANE_FRACTION = 0.15;

function isValidTabItem(
  item: unknown,
  seenOwners: ReadonlySet<string>,
): UaoWorktab | null {
  if (typeof item !== "object" || item === null) return null;
  const { ownerId, routeTarget } = item as Record<string, unknown>;
  if (
    typeof ownerId !== "string" ||
    typeof routeTarget !== "string" ||
    !isValidNavPaneId(ownerId) ||
    !isValidNavPaneId(routeTarget) ||
    !isFeatureOwner(ownerId) ||
    getFeatureOwnerId(routeTarget) !== ownerId ||
    seenOwners.has(ownerId)
  ) {
    return null;
  }
  return { ownerId, routeTarget };
}

/**
 * Validates and sanitizes persisted worktab state from localStorage.
 */
export function sanitizePersistedWorktabs(
  raw: unknown,
): PersistedWorktabsState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) return null;

  const seenOwners = new Set<string>();
  const validatedTabs: UaoWorktab[] = [];

  for (const item of obj.tabs) {
    const valid = isValidTabItem(item, seenOwners);
    if (valid !== null) {
      seenOwners.add(valid.ownerId);
      validatedTabs.push(valid);
      if (validatedTabs.length >= MAX_WORKTABS) break;
    }
  }

  if (validatedTabs.length === 0) return null;

  const rawOwner = obj.activeOwnerId;
  const activeOwnerId =
    typeof rawOwner === "string" && seenOwners.has(rawOwner)
      ? rawOwner
      : validatedTabs[0].ownerId;

  const rawRoute = obj.activeRouteId;
  const isRouteMatch =
    typeof rawRoute === "string" &&
    isValidNavPaneId(rawRoute) &&
    getFeatureOwnerId(rawRoute) === activeOwnerId;

  const fallbackRoute =
    validatedTabs.find((t) => t.ownerId === activeOwnerId)?.routeTarget ??
    activeOwnerId;

  const activeRouteId = isRouteMatch ? rawRoute : fallbackRoute;

  return {
    tabs: validatedTabs.map((tab) =>
      tab.ownerId === activeOwnerId
        ? { ...tab, routeTarget: activeRouteId }
        : tab,
    ),
    activeOwnerId,
    activeRouteId,
  };
}

/**
 * Open or select a tab for a feature.
 * One tab per feature owner. If owner tab exists, updates its routeTarget.
 * If not, appends the owner tab. Only an explicit close removes a tab.
 */
export function openWorktab(
  tabs: readonly UaoWorktab[],
  targetPaneId: string,
): PersistedWorktabsState {
  // If target is chat, owner is WORKSPACE_PANE_ID
  const effectiveTarget =
    targetPaneId === "chat" ? WORKSPACE_PANE_ID : targetPaneId;
  const ownerId = getFeatureOwnerId(effectiveTarget);

  const existingIndex = tabs.findIndex((t) => t.ownerId === ownerId);
  if (existingIndex >= 0) {
    const nextTabs = tabs.map((tab, idx) =>
      idx === existingIndex ? { ...tab, routeTarget: effectiveTarget } : tab,
    );
    return {
      tabs: nextTabs,
      activeOwnerId: ownerId,
      activeRouteId: effectiveTarget,
    };
  }

  const newTab: UaoWorktab = { ownerId, routeTarget: effectiveTarget };
  const nextTabs = [...tabs, newTab];

  return {
    tabs: nextTabs,
    activeOwnerId: ownerId,
    activeRouteId: effectiveTarget,
  };
}

/**
 * Select an existing owner tab without changing its saved routeTarget.
 */
export function selectWorktab(
  tabs: readonly UaoWorktab[],
  ownerId: string,
): PersistedWorktabsState {
  const tab = tabs.find((t) => t.ownerId === ownerId);
  if (!tab) {
    return openWorktab(tabs, ownerId);
  }
  return {
    tabs,
    activeOwnerId: ownerId,
    activeRouteId: tab.routeTarget,
  };
}

/**
 * Update the route target of an existing worktab (e.g. child navigation in embedded frame).
 */
export function updateWorktabRoute(
  tabs: readonly UaoWorktab[],
  newRouteId: string,
): PersistedWorktabsState {
  return openWorktab(tabs, newRouteId);
}

/**
 * Close a worktab by owner ID.
 * Selects nearest other tab (same index or previous) or defaults to DEFAULT_PANE_ID if empty.
 * Never destroys agents or terminal runtimes.
 */
export function closeWorktab(
  tabs: readonly UaoWorktab[],
  currentActiveOwnerId: string,
  ownerIdToClose: string,
): PersistedWorktabsState {
  const index = tabs.findIndex((t) => t.ownerId === ownerIdToClose);
  if (index < 0) {
    const activeTab = tabs.find((t) => t.ownerId === currentActiveOwnerId);
    return {
      tabs,
      activeOwnerId: currentActiveOwnerId,
      activeRouteId: activeTab?.routeTarget ?? currentActiveOwnerId,
    };
  }

  const remainingTabs = tabs.filter((t) => t.ownerId !== ownerIdToClose);
  if (remainingTabs.length === 0) {
    const defaultTab: UaoWorktab = {
      ownerId: DEFAULT_PANE_ID,
      routeTarget: DEFAULT_PANE_ID,
    };
    return {
      tabs: [defaultTab],
      activeOwnerId: DEFAULT_PANE_ID,
      activeRouteId: DEFAULT_PANE_ID,
    };
  }

  if (currentActiveOwnerId !== ownerIdToClose) {
    const activeTab = remainingTabs.find(
      (t) => t.ownerId === currentActiveOwnerId,
    );
    return {
      tabs: remainingTabs,
      activeOwnerId: currentActiveOwnerId,
      activeRouteId: activeTab?.routeTarget ?? currentActiveOwnerId,
    };
  }

  // Nearest other: same index if within bounds, else previous tab (last tab)
  const nextActiveIndex =
    index < remainingTabs.length ? index : remainingTabs.length - 1;
  const nextActive = remainingTabs[nextActiveIndex];

  return {
    tabs: remainingTabs,
    activeOwnerId: nextActive.ownerId,
    activeRouteId: nextActive.routeTarget,
  };
}

export interface WorkspaceLayoutPreferences {
  readonly sizes3: readonly [number, number, number];
  readonly sizes2: readonly [number, number];
}

export function sanitizeWorkspaceLayout(
  raw: unknown,
): WorkspaceLayoutPreferences {
  const defaults: WorkspaceLayoutPreferences = {
    sizes3: DEFAULT_3PANE_SIZES,
    sizes2: DEFAULT_2PANE_SIZES,
  };
  if (typeof raw !== "object" || raw === null) return defaults;
  const obj = raw as Record<string, unknown>;

  let sizes3: [number, number, number] = [...DEFAULT_3PANE_SIZES];
  if (
    Array.isArray(obj.sizes3) &&
    obj.sizes3.length === 3 &&
    obj.sizes3.every(
      (s): s is number => typeof s === "number" && s >= MIN_PANE_FRACTION,
    )
  ) {
    const sum = obj.sizes3[0] + obj.sizes3[1] + obj.sizes3[2];
    if (Math.abs(sum - 1.0) < 0.05) {
      sizes3 = [obj.sizes3[0] / sum, obj.sizes3[1] / sum, obj.sizes3[2] / sum];
    }
  }

  let sizes2: [number, number] = [...DEFAULT_2PANE_SIZES];
  if (
    Array.isArray(obj.sizes2) &&
    obj.sizes2.length === 2 &&
    obj.sizes2.every(
      (s): s is number => typeof s === "number" && s >= MIN_PANE_FRACTION,
    )
  ) {
    const sum = obj.sizes2[0] + obj.sizes2[1];
    if (Math.abs(sum - 1.0) < 0.05) {
      sizes2 = [obj.sizes2[0] / sum, obj.sizes2[1] / sum];
    }
  }

  return { sizes3, sizes2 };
}
