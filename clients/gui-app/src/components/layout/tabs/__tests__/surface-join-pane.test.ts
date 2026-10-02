/**
 * `surface-join-pane.ts`: which pane's fill an active tab's join takes, by what
 * its surface paints along the edge the tab runs into. A task, a draft and
 * Settings paint `--background`, so their tab takes `surface`; Home and
 * History paint nothing of their own and show their sheet's `canvas`.
 *
 * The rule is a table so a new kind has to say what its surface paints (the
 * `satisfies Record<HeaderTabKind, ...>` in the module); this pins every row
 * of it, and the three ways a strip item can name a pane (a lone tab, a split
 * pair, an item that is gone).
 */
import { describe, expect, it } from "vitest";
import {
  tabItemId,
  type SplitSide,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { TabRef } from "@/stores/tabs/types";
import type { SheetJoinPane } from "../side-strip/side-tab-join";
import {
  SPLIT_PAIR_JOIN_PANE,
  stripItemJoinPane,
  surfaceJoinPane,
} from "../surface-join-pane";

const PANE_BY_KIND: ReadonlyArray<{
  readonly kind: HeaderTabKind;
  readonly pane: SheetJoinPane;
}> = [
  { kind: "epic", pane: "surface" },
  { kind: "draft", pane: "surface" },
  { kind: "settings", pane: "surface" },
  { kind: "home", pane: "canvas" },
  { kind: "history", pane: "canvas" },
  { kind: "sample-workspace", pane: "canvas" },
];

function tabItem(kind: HeaderTabKind): StripItem {
  const ref: TabRef = { kind, id: `${kind}-1` };
  return { kind: "tab", id: tabItemId(ref), ref };
}

function tabSide(kind: HeaderTabKind): SplitSide {
  return { kind: "tab", ref: { kind, id: `${kind}-1` } };
}

function splitItem(left: SplitSide, right: SplitSide): SplitStripItem {
  return {
    kind: "split",
    id: "split-1",
    left,
    right,
    focusedSide: "left",
    routeBackingSide: "left",
    leftRatio: 0.5,
  };
}

describe("surfaceJoinPane", () => {
  it.each(PANE_BY_KIND)("$kind takes the $pane pane", ({ kind, pane }) => {
    expect(surfaceJoinPane(kind)).toBe(pane);
  });
});

describe("SPLIT_PAIR_JOIN_PANE", () => {
  it("is the surface pane: a pair always holds a surface that paints the background", () => {
    expect(SPLIT_PAIR_JOIN_PANE).toBe("surface");
  });
});

describe("stripItemJoinPane", () => {
  it.each(PANE_BY_KIND)(
    "a lone $kind tab joins the $pane pane",
    ({ kind, pane }) => {
      expect(stripItemJoinPane(tabItem(kind))).toBe(pane);
    },
  );

  it("a split pair of two tasks joins the surface pane", () => {
    expect(stripItemJoinPane(splitItem(tabSide("epic"), tabSide("epic")))).toBe(
      "surface",
    );
  });

  it("a split pair joins the surface pane whichever kinds it holds, History's canvas pane included", () => {
    expect(
      stripItemJoinPane(splitItem(tabSide("history"), tabSide("epic"))),
    ).toBe("surface");
    expect(
      stripItemJoinPane(splitItem(tabSide("draft"), tabSide("history"))),
    ).toBe("surface");
  });

  it("a split pair with an empty member still joins the surface pane", () => {
    expect(
      stripItemJoinPane(splitItem(tabSide("epic"), { kind: "empty" })),
    ).toBe("surface");
  });

  it("an item that is gone joins the surface pane: it was a task's", () => {
    expect(stripItemJoinPane(undefined)).toBe("surface");
  });
});
