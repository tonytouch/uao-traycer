import { describe, expect, it } from "vitest";
import { config } from "../../../../../desktop/src/config";
import {
  ALL_NAV_PANES,
  DEFAULT_PANE_ID,
  filterNavPanes,
  findNavPane,
  getFeatureOwnerId,
  getFeatureOwnerPane,
  isFeatureOwner,
  isValidNavPaneId,
  NAV_GROUPS,
  normalizeNavId,
  PRIORITY_PANE_IDS,
  WORKSPACE_PANE_ID,
  WORKSPACES_PANE_ID,
  OFFICE_PANE_ID,
  isNativeUaoPane,
  FEATURE_OWNER_MAP,
} from "../uao-nav-registry";
import {
  buildCspDirectives,
  isUaoDevMode,
  isUaoProxyDocument,
  UAO_EMBEDDED_TOOL_ORIGINS,
} from "../../../../../desktop/src/shared/content-security-policy";

describe("UAO Navigation Registry & Inventory", () => {
  it("contains the original UAO panes plus tasks, Workspace and Office workspaces", () => {
    expect(ALL_NAV_PANES).toHaveLength(39);
    const uniqueIds = new Set(ALL_NAV_PANES.map((p) => p.id));
    expect(uniqueIds.size).toBe(39);
  });

  it("sets command-center as the default pane", () => {
    expect(DEFAULT_PANE_ID).toBe("command-center");
    const defaultPane = findNavPane(DEFAULT_PANE_ID);
    expect(defaultPane).toBeDefined();
    expect(defaultPane?.label).toBe("Command Center");
  });

  it("includes the priority three panes with correct IDs and priority flags", () => {
    expect(PRIORITY_PANE_IDS).toEqual([
      "command-center",
      "agent-cockpit",
      "second-brain",
    ]);

    for (const id of PRIORITY_PANE_IDS) {
      const pane = findNavPane(id);
      expect(pane).toBeDefined();
      expect(pane?.group).toBe("priority");
    }
  });

  it("retains the existing tasks/chat/detail workspace as an extra nav item", () => {
    expect(WORKSPACE_PANE_ID).toBe("tasks-workspace");
    const ws = findNavPane(WORKSPACE_PANE_ID);
    expect(ws).toBeDefined();
    expect(ws?.label).toBe("Tasks & Chat");
    expect(ws?.group).toBe("workspace");
  });

  it("includes the workspace workspaces pane with correct ID, group, and label", () => {
    expect(WORKSPACES_PANE_ID).toBe("workspaces");
    const workspace = findNavPane(WORKSPACES_PANE_ID);
    expect(workspace).toBeDefined();
    expect(workspace?.label).toBe("Workspaces & Agent Terminals");
    expect(workspace?.group).toBe("workspace");
    expect(isNativeUaoPane(WORKSPACES_PANE_ID)).toBe(true);
    expect(isNativeUaoPane(WORKSPACE_PANE_ID)).toBe(true);
    expect(
      ALL_NAV_PANES.filter((pane) => !isNativeUaoPane(pane.id)),
    ).toHaveLength(34);
  });

  it("validates and normalizes route hashes correctly", () => {
    expect(isNativeUaoPane(OFFICE_PANE_ID)).toBe(true);
    expect(isNativeUaoPane("agent-os")).toBe(true);
    expect(findNavPane("agent-os")?.label).toBe("Agent OS");
    expect(findNavPane("agent-os")?.group).toBe("priority");
    expect(isNativeUaoPane("cloudroom")).toBe(true);
    expect(findNavPane("cloudroom")?.label).toBe("CloudRoom");
    expect(findNavPane("cloudroom")?.group).toBe("priority");
    expect(normalizeNavId("#/office")).toBe(OFFICE_PANE_ID);
    expect(filterNavPanes("genoffice").map((pane) => pane.id)).toEqual([
      OFFICE_PANE_ID,
    ]);
    expect(getFeatureOwnerId(OFFICE_PANE_ID)).toBe(OFFICE_PANE_ID);
    expect(isValidNavPaneId("command-center")).toBe(true);
    expect(isValidNavPaneId("agent-cockpit")).toBe(true);
    expect(isValidNavPaneId("second-brain")).toBe(true);
    expect(isValidNavPaneId("tasks-workspace")).toBe(true);
    expect(isValidNavPaneId("workspaces")).toBe(true);
    expect(isValidNavPaneId("non-existent-pane")).toBe(false);

    expect(normalizeNavId("#/second-brain")).toBe("second-brain");
    expect(normalizeNavId("#second-brain")).toBe("second-brain");
    expect(normalizeNavId("second-brain")).toBe("second-brain");
    expect(normalizeNavId("#/workspaces")).toBe("workspaces");
    expect(normalizeNavId("#/chat")).toBe("tasks-workspace");
    expect(normalizeNavId("chat")).toBe("tasks-workspace");
    expect(normalizeNavId("")).toBe("command-center");
    expect(normalizeNavId("#/invalid-slug")).toBe("command-center");
  });

  it("maps consolidated features to their canonical component owners", () => {
    expect(FEATURE_OWNER_MAP["mission-control"]).toBe("command-center");
    // mission-control inside command-center
    expect(getFeatureOwnerId("mission-control")).toBe("command-center");
    expect(isFeatureOwner("mission-control")).toBe(false);

    // memory-wiki/vault-graph/knowledge-galaxy inside second-brain
    expect(getFeatureOwnerId("memory-wiki")).toBe("second-brain");
    expect(getFeatureOwnerId("vault-graph")).toBe("second-brain");
    expect(getFeatureOwnerId("knowledge-galaxy")).toBe("second-brain");

    // agent/swarm-orchestrator/coding-cli/agents-roster/hermes-webui/omnigent inside agent-cockpit
    expect(getFeatureOwnerId("agent")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("swarm-orchestrator")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("coding-cli")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("agents-roster")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("hermes-webui")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("omnigent")).toBe("agent-cockpit");

    // telemetry/logs/pwa-hitl inside operations-pulse
    expect(getFeatureOwnerId("telemetry")).toBe("operations-pulse");
    expect(getFeatureOwnerId("logs")).toBe("operations-pulse");
    expect(getFeatureOwnerId("pwa-hitl")).toBe("operations-pulse");

    // screens whose function another owner already provides
    expect(getFeatureOwnerId("mission-stream")).toBe("command-center");
    expect(getFeatureOwnerId("ai-studio")).toBe("creation-studio");
    expect(getFeatureOwnerId("claude-code")).toBe("agent-cockpit");
    expect(getFeatureOwnerId("mavis")).toBe("agent-cockpit");

    // chat inside tasks-workspace
    expect(getFeatureOwnerId("chat")).toBe(WORKSPACE_PANE_ID);

    // canonical owners are feature owners
    expect(isFeatureOwner("command-center")).toBe(true);
    expect(isFeatureOwner("second-brain")).toBe(true);
    expect(isFeatureOwner("agent-cockpit")).toBe(true);
    expect(isFeatureOwner("operations-pulse")).toBe(true);
    expect(isFeatureOwner("tasks-workspace")).toBe(true);

    const wikiOwnerPane = getFeatureOwnerPane("memory-wiki");
    expect(wikiOwnerPane?.id).toBe("second-brain");
  });

  it("filters panes accurately by label, id, and keywords", () => {
    // Label search
    const cockpitSearch = filterNavPanes("cockpit");
    expect(cockpitSearch.some((p) => p.id === "agent-cockpit")).toBe(true);

    // Keyword search: e.g. "coding" should find Claude Code and Coding CLI
    const codingSearch = filterNavPanes("coding");
    expect(codingSearch.some((p) => p.id === "claude-code")).toBe(true);
    expect(codingSearch.some((p) => p.id === "coding-cli")).toBe(true);

    // Workspace search
    const workspaceSearch = filterNavPanes("workspace");
    expect(workspaceSearch.some((p) => p.id === "workspaces")).toBe(true);

    // Empty search returns all panes
    expect(filterNavPanes("")).toHaveLength(39);
    expect(filterNavPanes("cloudroom").map((pane) => pane.id)).toEqual([
      "cloudroom",
    ]);
  });

  it("labels backend terminal as Service Terminals vs Workspaces & Agent Terminals", () => {
    const terminal = findNavPane("terminal");
    expect(terminal).toBeDefined();
    expect(terminal?.label).toBe("Service Terminals");
    expect(terminal?.keywords).toContain("service");
  });

  it("organizes consolidated owner panes into the non-empty navigation groups", () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual([
      "priority",
      "workspace",
      "pinned",
      "agents",
      "system",
    ]);
    expect(NAV_GROUPS.every((group) => group.panes.length > 0)).toBe(true);
    const totalGroupPanes = NAV_GROUPS.reduce(
      (sum, g) => sum + g.panes.length,
      0,
    );
    expect(totalGroupPanes).toBe(21);
  });
});

describe("Dev-gated UAO Content-Security-Policy", () => {
  it("strictly preserves normal Traycer CSP when TRAYCER_DESKTOP_UAO_DEV is not set", () => {
    const normalEnv: NodeJS.ProcessEnv = {};
    expect(isUaoDevMode(normalEnv)).toBe(false);

    const directives = buildCspDirectives(normalEnv);
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("object-src 'none'");
    expect(directives).toContain("base-uri 'self'");
    expect(directives).toContain("form-action 'self'");
    expect(directives).not.toContain(
      expect.stringContaining("http://127.0.0.1:5050"),
    );
  });

  it("permits same-origin UAO framing while retaining connection/base/object/form restrictions", () => {
    const uaoEnv: NodeJS.ProcessEnv = {
      TRAYCER_DESKTOP_UAO_DEV: "1",
    };
    expect(isUaoDevMode(uaoEnv)).toBe(true);

    const directives = buildCspDirectives(uaoEnv);

    // frame-src allows self and inspected tool origins
    const frameSrc = directives.find((d) => d.startsWith("frame-src"));
    expect(frameSrc).toBe(`frame-src ${UAO_EMBEDDED_TOOL_ORIGINS}`);
    expect(frameSrc).toContain("'self'");
    expect(frameSrc).toBe("frame-src 'self'");

    // object-src, base-uri, and form-action remain strictly locked down
    expect(directives).toContain("object-src 'none'");
    expect(directives).toContain("base-uri 'self'");
    expect(directives).toContain("form-action 'self'");

    // The backend is same-origin; no extra connection origins are needed.
    const connectSrc = directives.find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBe(
      buildCspDirectives({}).find((d) => d.startsWith("connect-src")),
    );
  });
});

it("retains upstream policies only for exact local proxy paths", () => {
  const origin = "http://localhost:5182";
  expect(isUaoProxyDocument(`${origin}/uao-api/`, origin)).toBe(true);
  expect(isUaoProxyDocument(`${origin}/hermes-webui/chat`, origin)).toBe(true);
  expect(isUaoProxyDocument(`${origin}/uao.html?next=/uao-api/`, origin)).toBe(
    false,
  );
  expect(isUaoProxyDocument(`${origin}/uao-api-evil/`, origin)).toBe(false);
  expect(isUaoProxyDocument("https://example.com/uao-api/", origin)).toBe(
    false,
  );
});

it("does not broaden shipped builds when the UAO environment flag is present", () => {
  const environment = config.environment;
  try {
    config.environment = "production";
    const env = { TRAYCER_DESKTOP_UAO_DEV: "1" };
    expect(isUaoDevMode(env)).toBe(false);
    expect(buildCspDirectives(env)).toContain("frame-src 'none'");
  } finally {
    config.environment = environment;
  }
});
