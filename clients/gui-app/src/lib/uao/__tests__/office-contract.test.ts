import { describe, expect, it } from "vitest";
import { parseOfficeTabs } from "@traycer-clients/shared/uao-office";

describe("Office preload wire contract", () => {
  it("accepts native document snapshots and strips unrelated fields", () => {
    expect(parseOfficeTabs([{ id: "t1", kind: "docs", title: "Report.docx", active: true,
      closable: true, filePath: "/tmp/Report.docx", unexpected: "ignored" }])).toEqual([
      { id: "t1", kind: "docs", title: "Report.docx", active: true, closable: true, filePath: "/tmp/Report.docx" },
    ]);
  });
  it("refuses malformed or unsupported runtime documents", () => {
    expect(() => parseOfficeTabs(null)).toThrow();
    expect(() => parseOfficeTabs([{ id: "t1", kind: "shell", title: "Wrong", active: true, closable: true }])).toThrow();
    expect(() => parseOfficeTabs([{ id: "t1", kind: "docs", title: "Wrong", active: "true", closable: true }])).toThrow();
  });
});
