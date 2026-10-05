import { useRef, type KeyboardEvent } from "react";
import {
  Activity,
  BarChart2,
  Boxes,
  FileText,
  Globe,
  Inbox,
  MessageCircle,
  Mic,
  Monitor,
  Network,
  Rocket,
  Server,
  Sliders,
  Sparkles,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { DEFAULT_PANE_ID, findNavPane } from "./uao-nav-registry";
import type { UaoWorktab } from "./uao-worktabs-state";

const tabIcons: Readonly<Record<string, LucideIcon>> = {
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

export interface UaoWorktabsBarProps {
  readonly tabs: readonly UaoWorktab[];
  readonly activeOwnerId: string;
  readonly onSelectTab: (ownerId: string) => void;
  readonly onCloseTab: (ownerId: string) => void;
}

interface UaoWorktabItemProps {
  readonly tab: UaoWorktab;
  readonly index: number;
  readonly active: boolean;
  readonly onSelect: (ownerId: string) => void;
  readonly onClose: (ownerId: string) => void;
  readonly onKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => void;
  readonly registerRef: (ownerId: string, el: HTMLButtonElement | null) => void;
}

interface WorktabMetadata {
  readonly label: string;
  readonly fullTitle: string;
  readonly iconName: string;
}

function getWorktabMetadata(tab: UaoWorktab): WorktabMetadata {
  const owner = findNavPane(tab.ownerId);
  const target = findNavPane(tab.routeTarget);
  if (tab.routeTarget !== tab.ownerId && target !== undefined) {
    const ownerLabel = owner?.label ?? tab.ownerId;
    return {
      label: target.label,
      fullTitle: `${ownerLabel} › ${target.label}`,
      iconName: target.iconName,
    };
  }
  const label = owner?.label ?? tab.ownerId;
  return {
    label,
    fullTitle: label,
    iconName: owner?.iconName ?? "boxes",
  };
}

function UaoWorktabItem({
  tab,
  index,
  active,
  onSelect,
  onClose,
  onKeyDown,
  registerRef,
}: UaoWorktabItemProps) {
  const { label, fullTitle, iconName } = getWorktabMetadata(tab);
  const Icon = tabIcons[iconName] ?? Boxes;

  return (
    <div
      className={cn(
        "group relative flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-t-md px-2 text-ui-xs transition-colors",
        active
          ? "border-b-2 border-primary bg-background font-medium text-foreground shadow-xs"
          : "border-b-2 border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <TooltipWrapper
        label={fullTitle}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          ref={(el) => registerRef(tab.ownerId, el)}
          type="button"
          role="tab"
          id={`uao-tab-${tab.ownerId}`}
          aria-selected={active}
          aria-controls={`uao-panel-${tab.ownerId}`}
          tabIndex={active ? 0 : -1}
          onClick={() => onSelect(tab.ownerId)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              active ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span className="truncate">{label}</span>
        </button>
      </TooltipWrapper>

      <Button
        variant="muted"
        size="icon-xs"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.ownerId);
        }}
        aria-label={`Close ${label} tab`}
        className="shrink-0"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

export function UaoWorktabsBar({
  tabs,
  activeOwnerId,
  onSelectTab,
  onCloseTab,
}: UaoWorktabsBarProps) {
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleCloseTab = (ownerId: string) => {
    const index = tabs.findIndex((tab) => tab.ownerId === ownerId);
    const remaining = tabs.filter((tab) => tab.ownerId !== ownerId);
    const nextOwner =
      ownerId === activeOwnerId
        ? ((remaining.at(index) ?? remaining.at(-1))?.ownerId ??
          DEFAULT_PANE_ID)
        : activeOwnerId;
    onCloseTab(ownerId);
    requestAnimationFrame(() => tabButtonRefs.current.get(nextOwner)?.focus());
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const nextIndex = (index + 1) % tabs.length;
      const nextOwner = tabs[nextIndex].ownerId;
      onSelectTab(nextOwner);
      tabButtonRefs.current.get(nextOwner)?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prevIndex = (index - 1 + tabs.length) % tabs.length;
      const prevOwner = tabs[prevIndex].ownerId;
      onSelectTab(prevOwner);
      tabButtonRefs.current.get(prevOwner)?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      const firstOwner = tabs[0].ownerId;
      onSelectTab(firstOwner);
      tabButtonRefs.current.get(firstOwner)?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const lastOwner = tabs[tabs.length - 1].ownerId;
      onSelectTab(lastOwner);
      tabButtonRefs.current.get(lastOwner)?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      handleCloseTab(tabs[index].ownerId);
    }
  };

  const registerRef = (ownerId: string, el: HTMLButtonElement | null) => {
    if (el) tabButtonRefs.current.set(ownerId, el);
    else tabButtonRefs.current.delete(ownerId);
  };

  return (
    <div
      role="tablist"
      aria-label="Feature worktabs"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 bg-card/40 px-2 overflow-x-auto"
    >
      {tabs.map((tab, index) => (
        <UaoWorktabItem
          key={tab.ownerId}
          tab={tab}
          index={index}
          active={tab.ownerId === activeOwnerId}
          onSelect={onSelectTab}
          onClose={handleCloseTab}
          onKeyDown={handleKeyDown}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}
