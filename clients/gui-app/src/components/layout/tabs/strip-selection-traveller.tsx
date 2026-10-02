import type { Ref } from "react";
import { usePublishSheetJoin } from "./sheet-join-context";
import { useTravellingJoinPane } from "./strip-selection-travel";

/**
 * The stand-in selected box that slides between tabs; see
 * `strip-selection-travel.ts`. Rendered first in the strip's scroller, so it
 * paints under every tab.
 */
export function StripSelectionTraveller({
  ref,
}: {
  readonly ref: Ref<HTMLSpanElement>;
}) {
  const pane = useTravellingJoinPane();
  usePublishSheetJoin(pane, null);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="tab-selection-traveller"
      hidden={pane === null}
      // The join rule in `index.css` paints it exactly like a joined tab box:
      // its destination's fill, the sheet's border, open at the bottom.
      {...(pane === null
        ? {}
        : { "data-sheet-joined": "top", "data-join-pane": pane })}
      className="pointer-events-none absolute top-0 left-0 rounded-xl border"
    />
  );
}
