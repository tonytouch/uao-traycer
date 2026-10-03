import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANE_ID,
  ALL_NAV_PANES,
  getFeatureOwnerId,
  isFeatureOwner,
  WORKSPACE_PANE_ID,
} from "../uao-nav-registry";
import {
  closeWorktab,
  DEFAULT_2PANE_SIZES,
  DEFAULT_3PANE_SIZES,
  MAX_WORKTABS,
  MIN_PANE_FRACTION,
  openWorktab,
  sanitizePersistedWorktabs,
  sanitizeWorkspaceLayout,
  selectWorktab,
  updateWorktabRoute,
  type UaoWorktab,
} from "../uao-worktabs-state";

describe("UAO Worktabs State & Persistence", () => {
  describe("Invalid saved state sanitization", () => {
    it("rejects non-object or null input", () => {
      expect(sanitizePersistedWorktabs(null)).toBeNull();
      expect(sanitizePersistedWorktabs(undefined)).toBeNull();
      expect(sanitizePersistedWorktabs("corrupted")).toBeNull();
      expect(sanitizePersistedWorktabs(123)).toBeNull();
    });

    it("rejects non-array or empty tabs", () => {
      expect(sanitizePersistedWorktabs({})).toBeNull();
      expect(sanitizePersistedWorktabs({ tabs: "not-an-array" })).toBeNull();
      expect(sanitizePersistedWorktabs({ tabs: [] })).toBeNull();
    });

    it("rejects external URLs and invalid pane IDs", () => {
      const malicious = {
        tabs: [
          { ownerId: "https://evil.com", routeTarget: "https://evil.com" },
          { ownerId: "javascript:alert(1)", routeTarget: "command-center" },
          { ownerId: "command-center", routeTarget: "http://malicious.org" },
          { ownerId: "nonexistent-feature", routeTarget: "command-center" },
        ],
        activeOwnerId: "https://evil.com",
        activeRouteId: "https://evil.com",
      };
      expect(sanitizePersistedWorktabs(malicious)).toBeNull();
    });

    it("bounds saved tabs to known owners and deduplicates them", () => {
      const overflow = {
        tabs: [
          { ownerId: "command-center", routeTarget: "command-center" },
          { ownerId: "command-center", routeTarget: "mission-control" }, // duplicate owner
          { ownerId: "agent-cockpit", routeTarget: "agent-cockpit" },
          { ownerId: "second-brain", routeTarget: "second-brain" },
          { ownerId: "tasks-workspace", routeTarget: "tasks-workspace" },
          { ownerId: "orca-workspaces", routeTarget: "orca-workspaces" },
          { ownerId: "overview", routeTarget: "overview" },
          { ownerId: "creation-studio", routeTarget: "creation-studio" },
          { ownerId: "operations-pulse", routeTarget: "operations-pulse" },
          { ownerId: "mission-stream", routeTarget: "mission-stream" },
          { ownerId: "digital-employees", routeTarget: "digital-employees" },
          { ownerId: "openmaic", routeTarget: "openmaic" },
          { ownerId: "harnessrouter", routeTarget: "harnessrouter" },
          { ownerId: "jarvis", routeTarget: "jarvis" }, // 13th unique
        ],
        activeOwnerId: "command-center",
        activeRouteId: "command-center",
      };

      const sanitized = sanitizePersistedWorktabs(overflow);
      expect(sanitized).not.toBeNull();
      expect(sanitized?.tabs.length).toBeLessThanOrEqual(MAX_WORKTABS);
      const uniqueOwners = new Set(sanitized?.tabs.map((t) => t.ownerId));
      expect(uniqueOwners.size).toBe(sanitized?.tabs.length);
    });

    it("restores valid persisted worktab state", () => {
      const valid = {
        tabs: [
          { ownerId: "command-center", routeTarget: "mission-control" },
          { ownerId: "second-brain", routeTarget: "memory-wiki" },
        ],
        activeOwnerId: "second-brain",
        activeRouteId: "memory-wiki",
      };
      const sanitized = sanitizePersistedWorktabs(valid);
      expect(sanitized).toEqual(valid);
    });
  });

  describe("Owner deduplication & child route updates", () => {
    it("keeps earlier work when more than twelve features are opened", () => {
      const owners = ALL_NAV_PANES.filter((pane) => isFeatureOwner(pane.id));
      let state = openWorktab([], "memory-wiki");
      for (const owner of owners) {
        if (owner.id !== "second-brain") state = openWorktab(state.tabs, owner.id);
      }
      expect(state.tabs).toHaveLength(owners.length);
      expect(state.tabs.length).toBeGreaterThan(12);
      expect(selectWorktab(state.tabs, "second-brain").activeRouteId).toBe("memory-wiki");
      expect(sanitizePersistedWorktabs(state)?.tabs).toEqual(state.tabs);
    });

    it("creates a single owner tab and updates its routeTarget for child views", () => {
      const initial: readonly UaoWorktab[] = [
        { ownerId: "command-center", routeTarget: "command-center" },
      ];

      // Open second-brain
      const step1 = openWorktab(initial, "second-brain");
      expect(step1.tabs).toHaveLength(2);
      expect(step1.activeOwnerId).toBe("second-brain");
      expect(step1.activeRouteId).toBe("second-brain");

      // Open memory-wiki (a child of second-brain)
      const step2 = openWorktab(step1.tabs, "memory-wiki");
      // Still 2 tabs - no duplicate tab for memory-wiki!
      expect(step2.tabs).toHaveLength(2);
      expect(step2.activeOwnerId).toBe("second-brain");
      expect(step2.activeRouteId).toBe("memory-wiki");
      expect(
        step2.tabs.find((t) => t.ownerId === "second-brain")?.routeTarget,
      ).toBe("memory-wiki");

      // Open vault-graph (another child of second-brain)
      const step3 = openWorktab(step2.tabs, "vault-graph");
      expect(step3.tabs).toHaveLength(2);
      expect(step3.activeOwnerId).toBe("second-brain");
      expect(step3.activeRouteId).toBe("vault-graph");
      expect(
        step3.tabs.find((t) => t.ownerId === "second-brain")?.routeTarget,
      ).toBe("vault-graph");
    });

    it("routes 'chat' to tasks-workspace without creating separate chat tabs", () => {
      const initial: readonly UaoWorktab[] = [
        { ownerId: "command-center", routeTarget: "command-center" },
      ];

      const res = openWorktab(initial, "chat");
      expect(res.activeOwnerId).toBe(WORKSPACE_PANE_ID);
      expect(res.activeRouteId).toBe(WORKSPACE_PANE_ID);
      expect(res.tabs.some((t) => t.ownerId === WORKSPACE_PANE_ID)).toBe(true);
      expect(res.tabs.some((t) => t.ownerId === "chat")).toBe(false);
    });

    it("updates worktab route from child navigation events", () => {
      const tabs: readonly UaoWorktab[] = [
        { ownerId: "agent-cockpit", routeTarget: "agent-cockpit" },
      ];
      const updated = updateWorktabRoute(tabs, "swarm-orchestrator");
      expect(updated.activeOwnerId).toBe("agent-cockpit");
      expect(updated.activeRouteId).toBe("swarm-orchestrator");
      expect(updated.tabs[0].routeTarget).toBe("swarm-orchestrator");
    });

    it("selects an existing worktab preserving its current target", () => {
      const tabs: readonly UaoWorktab[] = [
        { ownerId: "command-center", routeTarget: "command-center" },
        { ownerId: "second-brain", routeTarget: "memory-wiki" },
      ];
      const selected = selectWorktab(tabs, "second-brain");
      expect(selected.activeOwnerId).toBe("second-brain");
      expect(selected.activeRouteId).toBe("memory-wiki");
      expect(selected.tabs).toHaveLength(2);
    });
  });

  describe("Closing worktabs", () => {
    it("selects the nearest other tab when closing the active tab", () => {
      const tabs: readonly UaoWorktab[] = [
        { ownerId: "command-center", routeTarget: "command-center" },
        { ownerId: "second-brain", routeTarget: "second-brain" },
        { ownerId: "agent-cockpit", routeTarget: "agent-cockpit" },
      ];

      // Close the middle active tab (second-brain) -> next tab at same index is agent-cockpit
      const res1 = closeWorktab(tabs, "second-brain", "second-brain");
      expect(res1.tabs).toHaveLength(2);
      expect(res1.activeOwnerId).toBe("agent-cockpit");

      // Close the last active tab (agent-cockpit) -> previous tab (command-center) is selected
      const res2 = closeWorktab(res1.tabs, "agent-cockpit", "agent-cockpit");
      expect(res2.tabs).toHaveLength(1);
      expect(res2.activeOwnerId).toBe("command-center");
    });

    it("restores the default command-center tab when the last tab is closed", () => {
      const tabs: readonly UaoWorktab[] = [
        { ownerId: "agent-cockpit", routeTarget: "agent-cockpit" },
      ];

      const res = closeWorktab(tabs, "agent-cockpit", "agent-cockpit");
      expect(res.tabs).toHaveLength(1);
      expect(res.tabs[0].ownerId).toBe(DEFAULT_PANE_ID);
      expect(res.activeOwnerId).toBe(DEFAULT_PANE_ID);
      expect(res.activeRouteId).toBe(DEFAULT_PANE_ID);
    });

    it("retains the active tab when a non-active tab is closed", () => {
      const tabs: readonly UaoWorktab[] = [
        { ownerId: "command-center", routeTarget: "command-center" },
        { ownerId: "second-brain", routeTarget: "second-brain" },
      ];

      const res = closeWorktab(tabs, "second-brain", "command-center");
      expect(res.tabs).toHaveLength(1);
      expect(res.activeOwnerId).toBe("second-brain");
    });
  });

  describe("Legacy search routes & component ownership", () => {
    it("resolves legacy child routes from search to their primary owners", () => {
      expect(getFeatureOwnerId("mission-control")).toBe("command-center");
      expect(getFeatureOwnerId("memory-wiki")).toBe("second-brain");
      expect(getFeatureOwnerId("telemetry")).toBe("operations-pulse");
      expect(getFeatureOwnerId("coding-cli")).toBe("agent-cockpit");

      expect(isFeatureOwner("command-center")).toBe(true);
      expect(isFeatureOwner("mission-control")).toBe(false);
    });
  });

  describe("Workspace layout preferences", () => {
    it("returns default 3-pane and 2-pane ratios", () => {
      expect(DEFAULT_3PANE_SIZES).toEqual([0.25, 0.45, 0.3]);
      expect(DEFAULT_2PANE_SIZES).toEqual([0.3, 0.7]);
      expect(MIN_PANE_FRACTION).toBe(0.15);
    });

    it("sanitizes invalid layout preferences", () => {
      const defaults = sanitizeWorkspaceLayout(null);
      expect(defaults.sizes3).toEqual(DEFAULT_3PANE_SIZES);
      expect(defaults.sizes2).toEqual(DEFAULT_2PANE_SIZES);

      // Sizes below minimum fraction 0.15 are rejected
      const invalid = sanitizeWorkspaceLayout({
        sizes3: [0.05, 0.85, 0.1],
        sizes2: [0.05, 0.95],
      });
      expect(invalid.sizes3).toEqual(DEFAULT_3PANE_SIZES);
      expect(invalid.sizes2).toEqual(DEFAULT_2PANE_SIZES);
    });

    it("accepts valid normalized layout preferences", () => {
      const valid = {
        sizes3: [0.2, 0.5, 0.3] as const,
        sizes2: [0.35, 0.65] as const,
      };
      const sanitized = sanitizeWorkspaceLayout(valid);
      expect(sanitized.sizes3[0]).toBeCloseTo(0.2);
      expect(sanitized.sizes3[1]).toBeCloseTo(0.5);
      expect(sanitized.sizes3[2]).toBeCloseTo(0.3);
      expect(sanitized.sizes2[0]).toBeCloseTo(0.35);
      expect(sanitized.sizes2[1]).toBeCloseTo(0.65);
    });
  });
});
