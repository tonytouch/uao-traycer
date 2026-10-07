import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart2,
  Boxes,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Inbox,
  MessageCircle,
  Mic,
  Monitor,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Search,
  Server,
  Sliders,
  Sparkles,
  Terminal,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import {
  ALL_NAV_PANES,
  filterNavPanes,
  getFeatureOwnerId,
  getFeatureOwnerPane,
  isFeatureOwner,
  NAV_GROUPS,
  type UaoNavPane,
} from "./uao-nav-registry";

const icons: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  "bar-chart-2": BarChart2,
  boxes: Boxes,
  "file-text": FileText,
  globe: Globe,
  inbox: Inbox,
  "message-circle": MessageCircle,
  mic: Mic,
  monitor: Monitor,
  network: Network,
  rocket: Rocket,
  server: Server,
  sliders: Sliders,
  sparkle: Sparkles,
  terminal: Terminal,
  users: Users,
};

const DEFAULT_COLLAPSED_PANES = ALL_NAV_PANES.filter((pane) =>
  isFeatureOwner(pane.id),
);

interface UaoSidebarProps {
  readonly activePaneId: string;
  readonly onSelectPane: (paneId: string) => void;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}

export function UaoSidebar({
  activePaneId,
  onSelectPane,
  collapsed,
  onToggleCollapsed,
}: UaoSidebarProps) {
  const [search, setSearch] = useState("");
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matches = useMemo(() => filterNavPanes(search), [search]);

  const focusSearch = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (collapsed) onToggleCollapsed();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const renderPane = (pane: UaoNavPane) => {
    const Icon = icons[pane.iconName] ?? Boxes;
    const isOwner = isFeatureOwner(pane.id);
    const owner = !isOwner ? getFeatureOwnerPane(pane.id) : undefined;
    const livesIn = owner && owner.id !== pane.id ? owner.label : undefined;
    const active =
      activePaneId === pane.id ||
      (isOwner && getFeatureOwnerId(activePaneId) === pane.id);
    const tooltipText = livesIn ? `${pane.label} (in ${livesIn})` : pane.label;

    return (
      <TooltipWrapper
        key={pane.id}
        label={tooltipText}
        side="right"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          aria-label={tooltipText}
          aria-current={active ? "page" : undefined}
          onClick={() => onSelectPane(pane.id)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-xs transition-colors",
            collapsed && "justify-center",
            active
              ? "bg-foreground/10 font-semibold text-foreground"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <Icon className={cn("size-3.5 shrink-0", active && "text-primary")} />
          {!collapsed && (
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{pane.label}</span>
              {livesIn ? (
                <span className="truncate text-micro text-muted-foreground">
                  in {livesIn}
                </span>
              ) : null}
            </div>
          )}
        </button>
      </TooltipWrapper>
    );
  };

  return (
    <nav
      aria-label="Agent OS Navigation"
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border/40 bg-card/40",
        collapsed ? "w-14" : "w-1/5 min-w-0",
      )}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 px-3">
        {!collapsed && (
          <span className="truncate font-heading text-ui-sm font-bold">
            UAO Navigation
          </span>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </Button>
      </div>
      {!collapsed && (
        <div className="relative border-b border-border/30 p-2">
          <Search className="pointer-events-none absolute top-4 left-4 size-3.5 text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch("");
            }}
            placeholder="Search features… (Ctrl+K)"
            aria-label="Search navigation features"
            className="w-full rounded-md border border-border/60 bg-foreground/5 py-1.5 pr-2 pl-8 text-ui-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {collapsed ? DEFAULT_COLLAPSED_PANES.map(renderPane) : null}
        {!collapsed && search.trim() && (
          <>
            <p
              role="status"
              className="px-2 py-1 text-micro text-muted-foreground"
            >
              {matches.length} matching features
            </p>
            {matches.map(renderPane)}
          </>
        )}
        {!collapsed &&
          !search.trim() &&
          NAV_GROUPS.map((group) => {
            const open = !closedGroups.has(group.id);
            return (
              <section key={group.id} className="mb-3">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`uao-nav-${group.id}`}
                  onClick={() =>
                    setClosedGroups((previous) => {
                      const next = new Set(previous);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  className="flex w-full items-center justify-between px-2 py-2 text-left font-mono text-micro text-muted-foreground uppercase"
                >
                  {group.label}
                  {open ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </button>
                <div id={`uao-nav-${group.id}`} hidden={!open}>
                  {group.panes.map(renderPane)}
                </div>
              </section>
            );
          })}
      </div>
    </nav>
  );
}
