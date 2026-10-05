import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  UAO_AGENTS_TAB_EVENT,
  UAO_AGENTS_TABS,
  isUaoAgentsTabId,
  readUaoAgentsTab,
  writeUaoAgentsTab,
  type UaoAgentsTabId,
} from "./uao-agents-tabs";
import {
  endpointsChromeLabel,
  type UaoEndpointsChrome,
  type UaoEndpointsReport,
} from "./uao-endpoints-chrome";
import { UaoAgentOsPane } from "./uao-agent-os-pane";
import { UaoCloudroomPane } from "./uao-cloudroom-pane";
import { UaoOpenMusePane } from "./uao-openmuse-pane";

interface AgentsHubChrome {
  readonly slots: Partial<Record<UaoAgentsTabId, UaoEndpointsReport>>;
  active: UaoAgentsTabId;
  readonly chromes: Readonly<Record<UaoAgentsTabId, UaoEndpointsChrome>>;
}

function createAgentsHubChrome(
  setExpanded: (expanded: boolean) => void,
  setLabel: (label: string) => void,
  initial: UaoAgentsTabId,
): AgentsHubChrome {
  const slots: AgentsHubChrome["slots"] = {};
  const active = { id: initial };
  const make = (id: UaoAgentsTabId): UaoEndpointsChrome => ({
    report: (state) => {
      slots[id] = state;
      if (active.id !== id) return;
      setExpanded(state.expanded);
      setLabel(state.label);
    },
  });
  return {
    slots,
    get active() {
      return active.id;
    },
    set active(id: UaoAgentsTabId) {
      active.id = id;
    },
    chromes: {
      "agent-os": make("agent-os"),
      cloudroom: make("cloudroom"),
      openmuse: make("openmuse"),
    },
  };
}

function AgentsTabPane({
  id,
  chrome,
}: {
  readonly id: UaoAgentsTabId;
  readonly chrome: UaoEndpointsChrome;
}) {
  if (id === "agent-os") return <UaoAgentOsPane endpointsChrome={chrome} />;
  if (id === "cloudroom") return <UaoCloudroomPane endpointsChrome={chrome} />;
  return <UaoOpenMusePane endpointsChrome={chrome} />;
}

function applyKnownEndpoints(
  hub: AgentsHubChrome,
  id: UaoAgentsTabId,
  setExpanded: (expanded: boolean) => void,
  setLabel: (label: string) => void,
): void {
  hub.active = id;
  const known = hub.slots[id];
  setExpanded(known?.expanded ?? false);
  setLabel(known?.label ?? endpointsChromeLabel(false));
}

export function UaoAgentsHub() {
  const [tab, setTab] = useState<UaoAgentsTabId>(() =>
    readUaoAgentsTab(window.localStorage),
  );
  const [visited, setVisited] = useState<ReadonlySet<UaoAgentsTabId>>(
    () => new Set([tab]),
  );
  const [expanded, setExpanded] = useState(false);
  const [label, setLabel] = useState(endpointsChromeLabel(false));
  const [hub] = useState(() =>
    createAgentsHubChrome(setExpanded, setLabel, tab),
  );
  if (!visited.has(tab)) {
    setVisited(new Set([...visited, tab]));
  }

  useEffect(() => {
    const onTab = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== "string" || !isUaoAgentsTabId(detail)) return;
      applyKnownEndpoints(hub, detail, setExpanded, setLabel);
      setTab(detail);
    };
    window.addEventListener(UAO_AGENTS_TAB_EVENT, onTab);
    return () => {
      window.removeEventListener(UAO_AGENTS_TAB_EVENT, onTab);
    };
  }, [hub]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
        <div
          role="tablist"
          aria-label="Agents"
          className="flex min-w-0 gap-1 overflow-x-auto"
        >
          {UAO_AGENTS_TABS.map((entry) => {
            const selected = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`uao-agents-tab-${entry.id}`}
                aria-selected={selected}
                aria-controls={`uao-agents-panel-${entry.id}`}
                onClick={() => {
                  writeUaoAgentsTab(window.localStorage, entry.id);
                }}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-ui-xs",
                  selected
                    ? "bg-foreground/10 font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={() => {
            hub.slots[hub.active]?.toggle();
          }}
        >
          {label}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {UAO_AGENTS_TABS.map((entry) =>
          visited.has(entry.id) ? (
            <div
              key={entry.id}
              id={`uao-agents-panel-${entry.id}`}
              role="tabpanel"
              aria-labelledby={`uao-agents-tab-${entry.id}`}
              hidden={tab !== entry.id}
              className="h-full min-h-0"
            >
              <AgentsTabPane id={entry.id} chrome={hub.chromes[entry.id]} />
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
