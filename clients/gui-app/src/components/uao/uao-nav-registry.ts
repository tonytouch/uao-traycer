/** Navigation snapshot from ultimate-agent-os/agent-os-ui/src/panes/registry.ts.
 * Screens stay owned by the backend-served UAO UI; refresh this inventory when it changes.
 */
import { isUaoAgentsTabId, UAO_AGENTS_PANE_ID } from "./uao-agents-tabs";

export { UAO_AGENTS_PANE_ID };

export type UaoNavGroupId =
  | "priority"
  | "workspace"
  | "pinned"
  | "work"
  | "agents"
  | "system";
export interface UaoNavPane {
  readonly id: string;
  readonly label: string;
  readonly iconName: string;
  readonly group: UaoNavGroupId;
  readonly keywords: readonly string[];
}
export const DEFAULT_PANE_ID = "command-center";
export const PRIORITY_PANE_IDS = [
  "command-center",
  "agent-cockpit",
  "second-brain",
] as const;
export const WORKSPACE_PANE_ID = "tasks-workspace";
export const WORKSPACES_PANE_ID = "workspaces";
export const OFFICE_PANE_ID = "office";
export function isNativeUaoPane(id: string): boolean {
  return (
    id === WORKSPACE_PANE_ID ||
    id === WORKSPACES_PANE_ID ||
    id === OFFICE_PANE_ID ||
    id === UAO_AGENTS_PANE_ID
  );
}

const paneRows: readonly (readonly [
  string,
  string,
  string,
  UaoNavGroupId,
  readonly string[],
])[] = [
  [
    UAO_AGENTS_PANE_ID,
    "Agents",
    "users",
    "priority",
    [
      "agents",
      "agent os",
      "cloudroom",
      "openmuse",
      "embed",
      "webview",
      "tailscale",
      "remote",
      "hermes",
      "omniroute",
      "5050",
      "9840",
      "8081",
      "8797",
      "session",
      "codex",
    ],
  ],
  [
    "command-center",
    "Command Center",
    "rocket",
    "priority",
    ["command", "brief", "dispatches", "mission"],
  ],
  [
    "agent-cockpit",
    "Agent Cockpit",
    "users",
    "priority",
    ["cockpit", "swarm", "acp", "cli", "runtime"],
  ],
  [
    "second-brain",
    "Second Brain",
    "file-text",
    "priority",
    ["memory", "brain", "wiki", "vault", "graph", "galaxy", "jarvis", "cosmos"],
  ],
  [
    "tasks-workspace",
    "Tasks & Chat",
    "boxes",
    "workspace",
    ["tasks", "chat", "kanban", "board", "details"],
  ],
  [
    "workspaces",
    "Workspaces & Agent Terminals",
    "terminal",
    "workspace",
    ["workspace", "workspaces", "worktree", "terminals", "agent", "screen"],
  ],
  [
    "office",
    "Office",
    "file-text",
    "workspace",
    [
      "genoffice",
      "office",
      "word",
      "excel",
      "powerpoint",
      "documents",
      "spreadsheets",
      "slides",
      "pdf",
      "markdown",
      "html",
    ],
  ],
  [
    "overview",
    "Overview",
    "sparkle",
    "pinned",
    ["overview", "home", "showcase"],
  ],
  [
    "creation-studio",
    "Creation Studio",
    "sparkle",
    "pinned",
    ["creation", "studio", "ideas", "content", "sandbox", "deploy", "viral"],
  ],
  [
    "operations-pulse",
    "Operations Pulse",
    "bar-chart-2",
    "pinned",
    [
      "operations",
      "telemetry",
      "pulse",
      "cost",
      "tokens",
      "logs",
      "fleet",
      "health",
    ],
  ],
  [
    "chat",
    "Chat",
    "message-circle",
    "pinned",
    ["messaging", "conversation", "talk"],
  ],
  [
    "mission-control",
    "Mission Control",
    "rocket",
    "work",
    ["mission", "brief", "dispatches"],
  ],
  [
    "mission-stream",
    "Mission Stream",
    "activity",
    "work",
    [
      "mission",
      "event",
      "log",
      "stream",
      "lifecycle",
      "approval",
      "evidence",
      "verification",
    ],
  ],
  [
    "digital-employees",
    "Digital Employees",
    "users",
    "agents",
    [
      "browser",
      "automation",
      "workers",
      "screencast",
      "warmwind",
      "fleet",
      "computer-use",
    ],
  ],
  [
    "swarm-orchestrator",
    "Swarm Orchestrator",
    "network",
    "agents",
    ["swarm", "orchestrator", "pipeline", "graph", "multi-agent"],
  ],
  ["agents-roster", "Agents Roster", "users", "agents", ["roster"]],
  [
    "hermes-webui",
    "Hermes WebUI",
    "message-circle",
    "agents",
    ["hermes", "webui", "sessions", "chat", "8787", "iframe"],
  ],
  [
    "omnigent",
    "Omnigent",
    "network",
    "agents",
    ["omnigent", "multi-agent", "approvals", "6767", "8446", "iframe"],
  ],
  [
    "openmaic",
    "OpenMAIC",
    "monitor",
    "agents",
    ["openmaic", "classroom", "maic", "iframe", "3021"],
  ],
  [
    "harnessrouter",
    "HarnessRouter",
    "network",
    "agents",
    ["harnessrouter", "harness", "codex", "claude", "hermes", "iframe", "3000"],
  ],
  [
    "jarvis",
    "Jarvis",
    "mic",
    "agents",
    ["voice", "speech", "assistant", "butler"],
  ],
  [
    "agent",
    "Agent Console",
    "sparkle",
    "agents",
    ["acp", "unified", "coding", "gemini", "claude", "codex", "normalized"],
  ],
  [
    "ai-studio",
    "AI Studio",
    "sparkle",
    "agents",
    ["studio", "gemini", "prompt", "playground"],
  ],
  ["antigravity", "Antigravity", "rocket", "agents", ["ide", "editor"]],
  ["claude-code", "Claude Code", "sparkle", "agents", ["coding", "anthropic"]],
  [
    "coding-cli",
    "Coding CLI",
    "terminal",
    "agents",
    ["coding", "cli", "gemini", "opencode", "codex", "launch", "terminal"],
  ],
  ["mavis", "Mavis", "sparkle", "agents", ["assistant", "ai"]],
  [
    "prime",
    "Prime",
    "sparkle",
    "agents",
    ["prime", "prime-agent", "harness", "dispatch", "omniroute", "stream"],
  ],
  ["n8n", "n8n Workflows", "activity", "agents", ["automation", "workflows"]],
  [
    "paperclip-bridge",
    "Paperclip Bridge",
    "network",
    "agents",
    ["paperclip", "issues", "forward", "hermes-task"],
  ],
  [
    "homelab",
    "Homelab",
    "server",
    "system",
    [
      "homelab",
      "docker",
      "services",
      "containers",
      "server",
      "infra",
      "dozzle",
      "minio",
      "ports",
      "dashboard",
    ],
  ],
  [
    "telemetry",
    "AI Telemetry",
    "bar-chart-2",
    "system",
    [
      "telemetry",
      "cost",
      "tokens",
      "latency",
      "spending",
      "gemini",
      "claude",
      "deepseek",
      "ollama",
    ],
  ],
  [
    "pwa-hitl",
    "Mobile PWA & Push",
    "activity",
    "system",
    [
      "pwa",
      "mobile",
      "push",
      "notifications",
      "hitl",
      "approvals",
      "tailscale",
    ],
  ],
  ["logs", "Live Logs", "terminal", "system", ["debug", "output"]],
  [
    "terminal",
    "Service Terminals",
    "terminal",
    "system",
    ["console", "shell", "service", "backend"],
  ],
  [
    "memory-wiki",
    "Memory Wiki",
    "file-text",
    "system",
    ["wiki", "facts", "notes", "knowledge"],
  ],
  [
    "vault-graph",
    "Memory Graph",
    "network",
    "system",
    ["graph", "visualization"],
  ],
  [
    "knowledge-galaxy",
    "Knowledge Galaxy",
    "network",
    "system",
    ["galaxy", "3d", "graph", "memory", "visualization"],
  ],
];
export const ALL_NAV_PANES: readonly UaoNavPane[] = paneRows.map(
  ([id, label, iconName, group, keywords]) => ({
    id,
    label,
    iconName,
    group,
    keywords,
  }),
);

/**
 * Feature ownership mapping consolidating child subviews into primary owner components:
 * - mission-control, mission-stream -> command-center (mission dispatch and its event stream)
 * - memory-wiki, vault-graph, knowledge-galaxy -> second-brain
 * - agent, swarm-orchestrator, coding-cli, agents-roster, hermes-webui, omnigent -> agent-cockpit
 * - claude-code, mavis -> agent-cockpit (Agent Console already runs both through its unified adapters)
 * - ai-studio -> creation-studio (already a tab of Creation Studio)
 * - telemetry, logs, pwa-hitl -> operations-pulse
 * - chat -> tasks-workspace
 */
export const FEATURE_OWNER_MAP: Readonly<Record<string, string>> = {
  "mission-control": "command-center",
  "mission-stream": "command-center",
  "ai-studio": "creation-studio",
  "claude-code": "agent-cockpit",
  mavis: "agent-cockpit",
  "memory-wiki": "second-brain",
  "vault-graph": "second-brain",
  "knowledge-galaxy": "second-brain",
  agent: "agent-cockpit",
  "swarm-orchestrator": "agent-cockpit",
  "coding-cli": "agent-cockpit",
  "agents-roster": "agent-cockpit",
  "hermes-webui": "agent-cockpit",
  omnigent: "agent-cockpit",
  telemetry: "operations-pulse",
  logs: "operations-pulse",
  "pwa-hitl": "operations-pulse",
  chat: WORKSPACE_PANE_ID,
};

export function getFeatureOwnerId(id: string): string {
  return FEATURE_OWNER_MAP[id] ?? id;
}

export function isFeatureOwner(id: string): boolean {
  return !(id in FEATURE_OWNER_MAP);
}

export function getFeatureOwnerPane(id: string): UaoNavPane | undefined {
  const ownerId = getFeatureOwnerId(id);
  return findNavPane(ownerId);
}

const groupRows: readonly (readonly [UaoNavGroupId, string, string])[] = [
  ["priority", "Priority Features", "rocket"],
  ["workspace", "Workspace", "boxes"],
  ["pinned", "Core Panes", "sparkle"],
  ["work", "Work & Projects", "inbox"],
  ["agents", "Agents Fleet", "users"],
  ["system", "System & Tools", "sliders"],
];
// Groups whose screens were all folded into an owner are dropped, so the
// sidebar never shows a header with nothing under it.
export const NAV_GROUPS = groupRows
  .map(([id, label, iconName]) => ({
    id,
    label,
    iconName,
    panes: ALL_NAV_PANES.filter(
      (pane) => pane.group === id && isFeatureOwner(pane.id),
    ),
  }))
  .filter((group) => group.panes.length > 0);
export function findNavPane(id: string): UaoNavPane | undefined {
  return ALL_NAV_PANES.find((pane) => pane.id === id);
}
export function isValidNavPaneId(id: string): boolean {
  return findNavPane(id) !== undefined;
}
export function normalizeNavId(hashOrId: string): string {
  const id = hashOrId.replace(/^#\/?/, "").trim();
  if (id === "chat") return WORKSPACE_PANE_ID;
  if (isUaoAgentsTabId(id)) return UAO_AGENTS_PANE_ID;
  return isValidNavPaneId(id) ? id : DEFAULT_PANE_ID;
}
export function filterNavPanes(query: string): readonly UaoNavPane[] {
  const term = query.trim().toLowerCase();
  return ALL_NAV_PANES.filter((pane) =>
    [
      pane.label,
      pane.id,
      ...pane.keywords,
      groupRows.find(([groupId]) => groupId === pane.group)?.[1] ?? "",
    ].some((value) => value.toLowerCase().includes(term)),
  );
}
