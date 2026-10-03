import { useRef } from "react";
import {
  computeResizeHandleSizes,
  resizeHandleSizesEqual,
} from "@/components/epic-canvas/canvas/resize-handle-sizes";
import {
  inFlowPointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import { cn } from "@/lib/utils";

export interface WorkspaceResizeDividerProps {
  readonly index: number;
  readonly sizes: ReadonlyArray<number>;
  readonly minFraction: number;
  readonly onCommitSizes: (sizes: ReadonlyArray<number>) => void;
  readonly onReset: () => void;
}

interface DragState {
  readonly containerSize: number;
  readonly minSize: number;
  readonly previousChild: HTMLElement;
  readonly nextChild: HTMLElement;
  latestSizes: ReadonlyArray<number>;
}

export function WorkspaceResizeDivider({
  index,
  sizes,
  minFraction,
  onCommitSizes,
  onReset,
}: WorkspaceResizeDividerProps) {
  const dragRef = useRef<DragState | null>(null);

  const restoreCommittedPair = (drag: DragState): void => {
    drag.previousChild.style.flexGrow = String(sizes[index]);
    drag.nextChild.style.flexGrow = String(sizes[index + 1]);
  };

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const handle = event.currentTarget;
      const container = handle.parentElement;
      const previousChild = handle.previousElementSibling as HTMLElement | null;
      const nextChild = handle.nextElementSibling as HTMLElement | null;
      if (container === null || previousChild === null || nextChild === null) {
        return false;
      }
      const rect = container.getBoundingClientRect();
      const containerSize = rect.width;
      if (containerSize <= 0) return false;
      dragRef.current = {
        containerSize,
        minSize: minFraction,
        previousChild,
        nextChild,
        latestSizes: sizes,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const nextSizes = computeResizeHandleSizes({
        sizes,
        index,
        deltaRatio: deltaPx / drag.containerSize,
        minSize: drag.minSize,
      });
      drag.latestSizes = nextSizes;
      drag.previousChild.style.flexGrow = String(nextSizes[index]);
      drag.nextChild.style.flexGrow = String(nextSizes[index + 1]);
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      if (!resizeHandleSizesEqual(drag.latestSizes, sizes)) {
        onCommitSizes(drag.latestSizes);
        return;
      }
      restoreCommittedPair(drag);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      restoreCommittedPair(drag);
    },
    onReset,
    onKeyNudge: (nudgeDirection) => {
      onCommitSizes(
        computeResizeHandleSizes({
          sizes,
          index,
          deltaRatio: nudgeDirection * 0.05,
          minSize: minFraction,
        }),
      );
    },
  });

  const fraction = sizes[index] ?? 0.33;

  return (
    <div
      {...sliderProps}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-label="Resize workspace panes"
      className={cn(
        "relative z-10 shrink-0 bg-border/40 hover:bg-ring active:bg-ring transition-colors ring-offset-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        inFlowPointerDragHandleAxisClassName("horizontal"),
      )}
    />
  );
}
