import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOfficeSession,
  existingDocuments,
  parseOfficeSession,
  readOfficeSession,
  writeOfficeSession,
} from "../../../../../integrations/genoffice/office-session";

const tabs = (entries: [string, string | undefined][]) =>
  new Map(entries.map(([id, filePath]) => [id, { id, filePath }]));

describe("Office session", () => {
  it("records saved documents in tab order with the active one", () => {
    const session = buildOfficeSession(
      ["home", "t1", "t2", "t3", "t4", "t5"],
      tabs([
        ["home", undefined],
        ["t1", "/docs/Plan.docx"],
        ["t2", "/tmp/genoffice-new/abc/Untitled.xlsx"],
        ["t3", undefined],
        ["t4", "/profile/office-scratch/Untitled-1.pdf"],
        ["t5", "/docs/Budget.xlsx"],
      ]),
      "t5",
      ["/tmp", "/profile/office-scratch"],
    );
    expect(session).toEqual({ documents: ["/docs/Plan.docx", "/docs/Budget.xlsx"], active: 1 });
  });

  it("has no active document when an unsaved tab was in front", () => {
    expect(buildOfficeSession(["t1", "t2"], tabs([["t1", "/a.md"], ["t2", undefined]]), "t2", []))
      .toEqual({ documents: ["/a.md"], active: -1 });
  });

  it("rejects malformed session files", () => {
    expect(parseOfficeSession(null)).toEqual({ documents: [], active: -1 });
    expect(parseOfficeSession({ documents: ["relative.md", 4, "/ok.md"], active: 3 }))
      .toEqual({ documents: ["/ok.md"], active: -1 });
  });

  it("round-trips through disk and skips files that were deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "uao-office-session-"));
    const kept = join(dir, "kept.md");
    const active = join(dir, "active.docx");
    writeFileSync(kept, "x");
    writeFileSync(active, "x");
    const file = join(dir, "office-session.json");
    writeOfficeSession(file, { documents: [kept, join(dir, "gone.md"), active], active: 2 });
    expect(existingDocuments(readOfficeSession(file))).toEqual({ documents: [kept, active], active: 1 });
    expect(readOfficeSession(join(dir, "missing.json"))).toEqual({ documents: [], active: -1 });
  });
});
