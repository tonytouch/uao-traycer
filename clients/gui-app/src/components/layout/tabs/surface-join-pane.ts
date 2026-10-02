import type { StripItem } from "@/stores/tabs/layout";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

/**
 * The ground each kind of surface paints along the edge its tab joins, which
 * is the fill the join takes there. A task's top row (its status row and the
 * head of its panel), a draft and Settings paint `--background`; Home and
 * History paint nothing of their own and show their sheet's canvas.
 *
 * A side strip meeting a TASK reads the pane on its side instead
 * (`useSideTabJoin`): the panel, its rail, or the canvas itself.
 *
 * The session tab never joins; its entry keeps the table total, so a new kind
 * has to say what its surface paints.
 */
const SURFACE_JOIN_PANE = {
  epic: "surface",
  draft: "surface",
  settings: "surface",
  home: "canvas",
  history: "canvas",
  "sample-workspace": "canvas",
} as const satisfies Record<HeaderTabKind, SheetJoinPane>;

/**
 * A split pair's two surfaces share the sheet under the pair's one box. Of
 * the kinds a pair can hold only History shows canvas, and it is a singleton,
 * so every pair holds a surface that paints `--background`.
 */
export const SPLIT_PAIR_JOIN_PANE: SheetJoinPane = "surface";

export function surfaceJoinPane(kind: HeaderTabKind): SheetJoinPane {
  return SURFACE_JOIN_PANE[kind];
}

/** The pane a top strip item joins. An item that is gone was a task's. */
export function stripItemJoinPane(item: StripItem | undefined): SheetJoinPane {
  if (item === undefined) return SURFACE_JOIN_PANE.epic;
  return item.kind === "split"
    ? SPLIT_PAIR_JOIN_PANE
    : surfaceJoinPane(item.ref.kind);
}
