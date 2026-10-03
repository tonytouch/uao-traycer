import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Calendar,
  Clock,
  FileText,
  Folder,
  MessageSquare,
  User,
  X,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type KanbanComment,
  type KanbanEvent,
  type KanbanStatus,
  type KanbanTask,
  type KanbanTaskDetail,
} from "@/lib/uao/adapter";
import { uaoQueryOptions } from "@/lib/uao/query-options";

export interface UaoTaskDetailPaneProps {
  readonly taskId: string | null;
  readonly boardSlug: string | undefined;
  readonly onClose: () => void;
}

function getStatusBadgeVariant(
  status: KanbanStatus,
): "destructive" | "warning" | "success" | "info" | "muted" {
  switch (status) {
    case "blocked":
      return "destructive";
    case "running":
      return "warning";
    case "done":
      return "success";
    case "todo":
    case "ready":
    case "scheduled":
      return "info";
    default:
      return "muted";
  }
}

function formatTimestamp(epochSec: number | null | undefined): string {
  if (epochSec === null || epochSec === undefined || epochSec <= 0) return "—";
  return new Date(epochSec * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderEventPayload(event: KanbanEvent): string {
  if (event.payload === null || event.payload === undefined) return "";
  if (typeof event.payload === "string") return event.payload;
  try {
    return JSON.stringify(event.payload);
  } catch {
    return "";
  }
}

function TaskMetadataSection({ task }: { readonly task: KanbanTask }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card p-3 shadow-xs">
      <h4 className="mb-2 font-mono text-micro font-semibold uppercase tracking-wider text-muted-foreground">
        Task Metadata
      </h4>
      <dl className="grid grid-cols-2 gap-2.5 text-ui-xs">
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground">
            <User className="size-3" /> Assignee
          </dt>
          <dd className="mt-0.5 font-medium text-foreground">
            {task.assignee ?? "Unassigned"}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Folder className="size-3" /> Workspace Kind
          </dt>
          <dd className="mt-0.5 font-mono text-foreground">
            {task.workspace_kind ?? "None"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Folder className="size-3" /> Workspace Path
          </dt>
          <dd className="mt-0.5 truncate font-mono text-foreground">
            {task.workspace_path ?? "None"}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Calendar className="size-3" /> Created
          </dt>
          <dd className="mt-0.5 font-mono text-micro text-foreground">
            {formatTimestamp(task.created_at)}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Clock className="size-3" /> Completed
          </dt>
          <dd className="mt-0.5 font-mono text-micro text-foreground">
            {formatTimestamp(task.completed_at)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function TaskTimelineSection({
  events,
}: {
  readonly events: readonly KanbanEvent[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 font-mono text-micro font-semibold uppercase tracking-wider text-muted-foreground">
          <Activity className="size-3.5 text-primary" />
          Event Timeline
        </h4>
        <Badge variant="muted" size="xs">
          {events.length}
        </Badge>
      </div>

      {events.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground italic">
          No events recorded.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {events.map((evt) => {
            const payloadStr = renderEventPayload(evt);
            const eventKey = `${evt.kind}-${evt.created_at}-${payloadStr.slice(0, 24)}`;
            return (
              <div
                key={eventKey}
                className="flex flex-col gap-1 rounded-md border border-border/30 bg-card p-2 text-ui-xs"
              >
                <div className="flex items-center justify-between font-mono text-micro">
                  <span className="font-semibold text-primary">{evt.kind}</span>
                  <span className="text-muted-foreground">
                    {formatTimestamp(evt.created_at)}
                  </span>
                </div>
                {payloadStr.length > 0 && (
                  <p className="line-clamp-3 font-mono text-micro text-muted-foreground">
                    {payloadStr}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCommentsSection({
  comments,
}: {
  readonly comments: readonly KanbanComment[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 font-mono text-micro font-semibold uppercase tracking-wider text-muted-foreground">
          <MessageSquare className="size-3.5 text-primary" />
          Comments
        </h4>
        <Badge variant="muted" size="xs">
          {comments.length}
        </Badge>
      </div>

      {comments.length === 0 ? (
        <p className="text-ui-xs text-muted-foreground italic">
          No comments recorded on this task.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {comments.map((comment) => {
            const commentKey = `${comment.author}-${comment.created_at}-${comment.body.slice(0, 24)}`;
            return (
              <div
                key={commentKey}
                className="flex flex-col gap-1 rounded-lg border border-border/40 bg-card p-2.5 text-ui-xs"
              >
                <div className="flex items-center justify-between font-mono text-micro text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {comment.author}
                  </span>
                  <span>{formatTimestamp(comment.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap text-foreground">
                  {comment.body}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function UaoTaskDetailPane(props: UaoTaskDetailPaneProps) {
  const { taskId, boardSlug, onClose } = props;
  const detailQuery = useQuery(uaoQueryOptions.task(boardSlug, taskId));
  const activeDetail: KanbanTaskDetail | null = detailQuery.data ?? null;
  const activeError = detailQuery.error;
  const loading = taskId !== null && detailQuery.isPending;

  if (taskId === null) {
    return (
      <aside className="flex h-full w-full min-w-0 flex-col items-center justify-center border-l border-border/40 bg-card/20 p-6 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-foreground/5 text-muted-foreground">
          <FileText className="size-6 opacity-60" />
        </div>
        <h4 className="text-ui-sm font-semibold text-foreground">
          No Task Selected
        </h4>
        <p className="mt-1 max-w-xs text-ui-xs text-muted-foreground">
          Select a task from the Kanban list on the left to view workspace
          details, failure errors, and event history.
        </p>
      </aside>
    );
  }

  function renderBody(): ReactNode {
    if (loading && activeDetail === null) {
      return (
        <div className="flex h-60 flex-col items-center justify-center gap-2 text-muted-foreground">
          <AgentSpinningDots tone="muted" />
          <span className="text-ui-xs">Loading task details...</span>
        </div>
      );
    }

    if (detailQuery.isError) {
      return (
        <div className="m-4 flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-center">
          <AlertCircle className="size-5 text-destructive" />
          <span className="text-ui-xs font-medium text-destructive">
            {activeError instanceof Error
              ? activeError.message
              : "Failed to load task details"}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            Retry
          </Button>
        </div>
      );
    }

    if (activeDetail === null) {
      return null;
    }

    const { task, comments, events, latest_summary } = activeDetail;

    return (
      <div className="flex flex-col gap-5 p-4">
        {/* Title and Status */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge variant={getStatusBadgeVariant(task.status)} size="sm">
              {task.status}
            </Badge>
            {task.priority !== null && (
              <Badge variant="muted" size="sm">
                Priority: {task.priority}
              </Badge>
            )}
            {task.board_slug !== undefined && (
              <Badge variant="outline" size="sm">
                Board: {task.board_slug}
              </Badge>
            )}
          </div>
          <h2 className="text-ui font-semibold text-foreground leading-snug">
            {task.title}
          </h2>
        </div>

        {/* Failure Callout if present */}
        {task.last_failure_error !== null &&
          task.last_failure_error !== undefined && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive">
              <div className="flex items-center gap-1.5 font-semibold text-ui-xs">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span>Last Failure / Protocol Error</span>
              </div>
              <p className="font-mono text-micro leading-relaxed whitespace-pre-wrap opacity-90">
                {task.last_failure_error}
              </p>
            </div>
          )}

        {/* Latest Summary / Result if present */}
        {(latest_summary !== null || task.result !== null) && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-success/30 bg-success/10 p-3 text-success-foreground">
            <span className="font-semibold text-ui-xs">Result Summary</span>
            <p className="text-ui-xs leading-relaxed">
              {latest_summary ?? task.result}
            </p>
          </div>
        )}

        {/* Metadata Grid */}
        <TaskMetadataSection task={task} />

        {/* Task Body / Description */}
        {task.body !== null && task.body.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h4 className="font-mono text-micro font-semibold uppercase tracking-wider text-muted-foreground">
              Description
            </h4>
            <div className="rounded-lg border border-border/40 bg-foreground/5 p-3 font-mono text-ui-xs leading-relaxed whitespace-pre-wrap text-foreground">
              {task.body}
            </div>
          </div>
        )}

        {/* Event Timeline */}
        <TaskTimelineSection events={events} />

        {/* Comments Section */}
        <TaskCommentsSection comments={comments} />
      </div>
    );
  }

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border/40 bg-card/30 backdrop-blur-xs">
      {/* Pane Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-primary" />
          <span className="font-mono text-ui-xs font-semibold text-foreground">
            {taskId}
          </span>
          {boardSlug !== undefined && (
            <Badge variant="muted" size="xs">
              {boardSlug}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close task details"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Pane Scrollable Content */}
      <div className="flex-1 overflow-y-auto">{renderBody()}</div>
    </aside>
  );
}
