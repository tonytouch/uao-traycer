/** Tabs inside the Agents hub. The old sidebar ids still name these tabs. */

export const UAO_AGENTS_PANE_ID = "uao-agents";
export const UAO_AGENTS_TAB_STORAGE_KEY = "uao.agents-hub.tab.v1";
export const UAO_AGENTS_TAB_EVENT = "uao-agents-tab";

export const UAO_AGENTS_TABS = [
  { id: "agent-os", label: "Agent OS" },
  { id: "cloudroom", label: "CloudRoom" },
  { id: "openmuse", label: "OpenMuse" },
] as const;

export type UaoAgentsTabId = (typeof UAO_AGENTS_TABS)[number]["id"];

const LEGACY_AGENTS_TAB_IDS: ReadonlySet<string> = new Set(
  UAO_AGENTS_TABS.map((tab) => tab.id),
);

export function isUaoAgentsTabId(value: string): value is UaoAgentsTabId {
  return LEGACY_AGENTS_TAB_IDS.has(value);
}

export function uaoAgentsTabFromNavId(hashOrId: string): UaoAgentsTabId | null {
  const id = hashOrId.replace(/^#\/?/, "").trim();
  return isUaoAgentsTabId(id) ? id : null;
}

export function readUaoAgentsTab(
  storage: Pick<Storage, "getItem">,
): UaoAgentsTabId {
  try {
    const raw = storage.getItem(UAO_AGENTS_TAB_STORAGE_KEY);
    if (raw !== null && isUaoAgentsTabId(raw)) return raw;
  } catch {
    // Ignore unreadable storage and fall back to Agent OS.
  }
  return "agent-os";
}

function publishUaoAgentsTab(tab: UaoAgentsTabId): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(UAO_AGENTS_TAB_EVENT, { detail: tab }));
}

export function writeUaoAgentsTab(
  storage: Pick<Storage, "setItem">,
  tab: UaoAgentsTabId,
): void {
  try {
    storage.setItem(UAO_AGENTS_TAB_STORAGE_KEY, tab);
  } catch {
    // The hub still switches tabs when storage is full or blocked.
  }
  publishUaoAgentsTab(tab);
}

function agentsTabField(value: unknown): UaoAgentsTabId | null {
  if (typeof value === "string" && isUaoAgentsTabId(value)) return value;
  return null;
}

function agentsTabFromRecord(item: unknown): UaoAgentsTabId | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  return agentsTabField(record.routeTarget) ?? agentsTabField(record.ownerId);
}

/**
 * Which Agents tab a saved worktab strip was showing before the three
 * sidebar rows became one hub. The active legacy id wins. Otherwise the
 * last legacy row in the strip is the seed.
 */
export function legacyAgentsTabFromPersisted(
  raw: unknown,
): UaoAgentsTabId | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const active =
    agentsTabField(obj.activeRouteId) ?? agentsTabField(obj.activeOwnerId);
  if (active !== null) return active;
  if (!Array.isArray(obj.tabs)) return null;
  let fallback: UaoAgentsTabId | null = null;
  for (const item of obj.tabs) {
    const tab = agentsTabFromRecord(item);
    if (tab !== null) fallback = tab;
  }
  return fallback;
}

/**
 * A hash such as `#/cloudroom` selects that tab. A later launch with no
 * legacy hash keeps a tab the hub already stored.
 */
export function rememberUaoAgentsTab(
  hash: string,
  persisted: unknown,
  storage: Pick<Storage, "getItem" | "setItem">,
): void {
  const fromHash = uaoAgentsTabFromNavId(hash);
  if (fromHash !== null) {
    writeUaoAgentsTab(storage, fromHash);
    return;
  }
  let existing: string | null = null;
  try {
    existing = storage.getItem(UAO_AGENTS_TAB_STORAGE_KEY);
  } catch {
    return;
  }
  if (existing !== null && isUaoAgentsTabId(existing)) return;
  const seeded = legacyAgentsTabFromPersisted(persisted);
  if (seeded !== null) writeUaoAgentsTab(storage, seeded);
}

function rewriteLegacyAgentsId(value: unknown): unknown {
  if (typeof value !== "string" || !isUaoAgentsTabId(value)) return value;
  return UAO_AGENTS_PANE_ID;
}

function rewriteLegacyAgentsTab(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item;
  const record = item as Record<string, unknown>;
  const ownerId = rewriteLegacyAgentsId(record.ownerId);
  const routeTarget = rewriteLegacyAgentsId(record.routeTarget);
  if (ownerId === record.ownerId && routeTarget === record.routeTarget) {
    return item;
  }
  return { ...record, ownerId, routeTarget };
}

/** Fold saved Agent OS, CloudRoom, and OpenMuse worktabs into one Agents tab. */
export function rewriteLegacyAgentsWorktabs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) return raw;
  const tabs: unknown[] = [];
  let seenAgents = false;
  let changed = false;
  for (const item of obj.tabs) {
    const next = rewriteLegacyAgentsTab(item);
    if (next !== item) changed = true;
    if (typeof next === "object" && next !== null) {
      const owner = (next as Record<string, unknown>).ownerId;
      if (owner === UAO_AGENTS_PANE_ID) {
        if (seenAgents) {
          changed = true;
          continue;
        }
        seenAgents = true;
      }
    }
    tabs.push(next);
  }
  const activeOwnerId = rewriteLegacyAgentsId(obj.activeOwnerId);
  const activeRouteId = rewriteLegacyAgentsId(obj.activeRouteId);
  if (
    !changed &&
    activeOwnerId === obj.activeOwnerId &&
    activeRouteId === obj.activeRouteId
  ) {
    return raw;
  }
  return { ...obj, tabs, activeOwnerId, activeRouteId };
}
