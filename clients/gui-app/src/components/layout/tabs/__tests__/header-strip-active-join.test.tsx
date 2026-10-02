/**
 * Integrated regression: `isActive`/`joined` thread into the drag overlay
 * from a REAL `RootDndProvider` gesture, not a hand-set prop. The dragged row
 * is a minimal fake draggable, not the real `TabItem` - only the OVERLAY
 * subtree is under test here, and that's driven by the tabs store and the
 * drag payload regardless of how the source row itself is drawn. (The real
 * `TabItem` also auto-activates a tab the instant a drag picks it up, so an
 * "inactive dragged tab" is momentary in production; this file proves the
 * overlay renders correctly for that instant regardless of how briefly it
 * lasts, which the fake row's lack of that effect doesn't undermine.)
 *
 * A joined overlay also names the pane it runs into (`surfaceJoinPane`), and
 * the top bridge it owns must name the same one: a task or a split pair joins
 * "surface", History "canvas".
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useDraggable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { SheetJoinBridge } from "@/components/layout/tabs/sheet-join";
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

// Keep host notification RPCs outside the drag harness.
vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

const ACTIVE: TabRef = { kind: "epic", id: "tab-active" };
const INACTIVE: TabRef = { kind: "epic", id: "tab-inactive" };
const HISTORY: TabRef = { kind: "history", id: "history" };
const PAIR_LEFT: TabRef = { kind: "epic", id: "tab-pair-left" };
const PAIR_RIGHT: TabRef = { kind: "epic", id: "tab-pair-right" };
const SPLIT_ID = "split-pair";

function itemIdOf(ref: TabRef): string {
  return `tab:${ref.kind}:${ref.id}`;
}

function withRouter(harness: () => ReactNode) {
  const rootRoute = createRootRoute({ component: harness });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="route-body" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

/**
 * A bare draggable standing in for a strip item's row. `stripItemId` is the
 * item it stands for: the tab's own, or its split pair's (a pair is one drag
 * source, carried by one of its members).
 */
function StripRow(props: {
  readonly tabRef: TabRef;
  readonly stripItemId: string;
  readonly index: number;
}): ReactNode {
  const data: HeaderTabDragData = {
    kind: HEADER_TAB_DND_TYPE,
    stripItemId: props.stripItemId,
    tabKind: props.tabRef.kind,
    tabId: props.tabRef.id,
    index: props.index,
  };
  const { listeners, setNodeRef } = useDraggable({
    id: getHeaderTabDragId(
      props.tabRef.kind,
      props.stripItemId === itemIdOf(props.tabRef)
        ? props.tabRef.id
        : `${props.stripItemId}:${props.tabRef.id}`,
    ),
    data,
  });
  return (
    <button
      ref={setNodeRef}
      data-strip-item-id={props.stripItemId}
      data-strip-item-mergeable="true"
      data-testid={`row-${props.tabRef.id}`}
      {...listeners}
    >
      {props.tabRef.id}
    </button>
  );
}

function TopStrip(props: { readonly rows: ReactNode }): ReactNode {
  return (
    <div
      data-testid={HEADER_STRIP_SCROLL_TEST_ID}
      data-strip-axis="x"
      data-strip-edge="top"
    >
      {props.rows}
    </div>
  );
}

const EPIC_ROWS: ReactNode = (
  <>
    <StripRow tabRef={ACTIVE} stripItemId={itemIdOf(ACTIVE)} index={0} />
    <StripRow tabRef={INACTIVE} stripItemId={itemIdOf(INACTIVE)} index={1} />
  </>
);

function seedTwoTabs(): void {
  act(() => {
    for (const ref of [ACTIVE, INACTIVE]) {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, `${ref.id}-epic`, ref.id);
    }
    useTabsStore.setState({
      version: 2,
      items: [ACTIVE, INACTIVE].map((ref) => ({
        kind: "tab",
        id: itemIdOf(ref),
        ref,
      })),
      activeItemId: itemIdOf(ACTIVE),
      stripOrder: [ACTIVE, INACTIVE],
      systemTabs: { history: null, settings: null },
    });
  });
}

/** The History system tab, opened and made the active item. */
function seedActiveHistory(): void {
  act(() => {
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: "/epics",
    });
    useTabsStore.setState({ activeItemId: itemIdOf(HISTORY) });
  });
}

/** One split pair of two tasks, active, and nothing else in the strip. */
function seedActiveSplit(): void {
  act(() => {
    for (const ref of [PAIR_LEFT, PAIR_RIGHT]) {
      useEpicCanvasStore
        .getState()
        .openEpicTabWithId(ref.id, `${ref.id}-epic`, ref.id);
    }
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: SPLIT_ID,
          left: { kind: "tab", ref: PAIR_LEFT },
          right: { kind: "tab", ref: PAIR_RIGHT },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: SPLIT_ID,
      stripOrder: [PAIR_LEFT, PAIR_RIGHT],
      systemTabs: { history: null, settings: null },
    });
  });
}

async function mountTopStrip(rows: ReactNode): Promise<void> {
  const router = withRouter(() => (
    <QueryClientProvider client={new QueryClient()}>
      <RootDndProvider>
        <TopStrip rows={rows} />
        <SheetJoinBridge edge="top" />
      </RootDndProvider>
    </QueryClientProvider>
  ));
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

interface Drag {
  readonly source: HTMLElement;
  readonly pointerId: number;
}

/** Press, then cross the activation distance along x (the strip's own axis). */
function pressAndActivate(row: HTMLElement, pointerId: number): Drag {
  act(() => {
    fireEvent.pointerDown(row, {
      pointerId,
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
  });
  act(() => {
    fireEvent.pointerMove(row, {
      pointerId,
      clientX: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 1,
      clientY: 0,
    });
  });
  return { source: row, pointerId };
}

function releaseAt(drag: Drag): void {
  act(() => {
    fireEvent.pointerUp(drag.source, {
      pointerId: drag.pointerId,
      clientX: 0,
      clientY: 0,
    });
  });
}

function topBridge(): Element {
  const bridge = document.querySelector('[data-sheet-join-bridge="top"]');
  if (bridge === null) throw new Error("Expected the top join bridge");
  return bridge;
}

function overlayContainer(): HTMLElement {
  return screen.getByTestId("header-tab-drag-overlay");
}

describe("top strip drag overlay: active/inactive chrome and sheet join", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    seedTwoTabs();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("keeps an inactive dragged tab's inactive appearance on the overlay - no chrome box, no join", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${INACTIVE.id}`);
    const drag = pressAndActivate(row, 1);

    const overlay = overlayContainer();
    expect(within(overlay).queryByTestId("tab-chrome-box")).toBeNull();
    expect(within(overlay).getByTestId("tab-hover-box")).toBeTruthy();
    // The rows here are bare buttons, so only an ACTIVE overlay can publish:
    // the inactive one leaves the bridge unowned.
    expect(topBridge().hasAttribute("data-join-active")).toBe(false);

    releaseAt(drag);
  });

  it("draws the active dragged tab's overlay joined to the sheet", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${ACTIVE.id}`);
    const drag = pressAndActivate(row, 2);

    const overlay = overlayContainer();
    expect(
      within(overlay)
        .getByTestId("tab-chrome-box")
        .getAttribute("data-sheet-joined"),
    ).toBe("top");
    // The joined overlay is the one publisher, so it owns the bridge.
    expect(topBridge().hasAttribute("data-join-active")).toBe(true);

    releaseAt(drag);
  });

  // The pane is the fill the join takes (`index.css`), and the bridge paints
  // the same fill onto the sheet, so the two must name one pane. A task paints
  // `--background` along its top edge, so its tab joins "surface" - not the
  // canvas, which would leave the tab and the row under it two colours.
  it("joins the active dragged task's overlay to the surface pane, and the bridge with it", async () => {
    await mountTopStrip(EPIC_ROWS);
    const row = screen.getByTestId(`row-${ACTIVE.id}`);
    const drag = pressAndActivate(row, 3);

    expect(
      within(overlayContainer())
        .getByTestId("tab-chrome-box")
        .getAttribute("data-join-pane"),
    ).toBe("surface");
    expect(topBridge().getAttribute("data-join-pane")).toBe("surface");

    releaseAt(drag);
  });

  it("joins the active dragged History tab's overlay to the canvas pane, and the bridge with it", async () => {
    seedActiveHistory();
    await mountTopStrip(
      <StripRow tabRef={HISTORY} stripItemId={itemIdOf(HISTORY)} index={0} />,
    );
    const drag = pressAndActivate(screen.getByTestId(`row-${HISTORY.id}`), 4);

    const box = within(overlayContainer()).getByTestId("tab-chrome-box");
    expect(box.getAttribute("data-sheet-joined")).toBe("top");
    expect(box.getAttribute("data-join-pane")).toBe("canvas");
    expect(topBridge().getAttribute("data-join-pane")).toBe("canvas");

    releaseAt(drag);
  });

  it("joins the active dragged split pair's one box to the surface pane, and the bridge with it", async () => {
    seedActiveSplit();
    await mountTopStrip(
      <StripRow tabRef={PAIR_LEFT} stripItemId={SPLIT_ID} index={0} />,
    );
    const drag = pressAndActivate(screen.getByTestId(`row-${PAIR_LEFT.id}`), 5);

    const box = within(overlayContainer()).getByTestId(
      `split-tab-joined-${SPLIT_ID}`,
    );
    expect(box.getAttribute("data-sheet-joined")).toBe("top");
    expect(box.getAttribute("data-join-pane")).toBe("surface");
    expect(topBridge().getAttribute("data-join-pane")).toBe("surface");

    releaseAt(drag);
  });
});
