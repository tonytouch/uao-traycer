import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachDraftPersistence,
  discardDrafts,
  draftSignature,
} from "../draft-persistence";

const KEY = "uao-desktop-drafts:v1";
const detachers: (() => void)[] = [];

function attach(scope: string) {
  const detach = attachDraftPersistence(document, { scope: () => scope });
  detachers.push(detach);
  return detach;
}

function query<T extends Element = HTMLTextAreaElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function stored(): Record<string, { value: string }> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, { value: string }>;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  window.location.hash = "#/cockpit";
  document.body.innerHTML = `
    <textarea placeholder="Describe the task"></textarea>
    <input name="cwd" />
    <input type="password" name="pw" />
    <input name="apiKey" />
    <input />`;
});

afterEach(() => {
  while (detachers.length) detachers.pop()?.();
  vi.useRealTimers();
});

describe("draft persistence", () => {
  it("records unsent text and restores it into a fresh document", () => {
    attach("cockpit");
    type(query("textarea"), "Refactor the router");
    type(query<HTMLInputElement>("[name=cwd]"), "/srv/app");
    vi.advanceTimersByTime(500);
    expect(Object.values(stored()).map((d) => d.value).sort()).toEqual([
      "/srv/app",
      "Refactor the router",
    ]);

    detachers.pop()?.();
    document.body.innerHTML = `<textarea placeholder="Describe the task"></textarea><input name="cwd" />`;
    const onInput = vi.fn();
    query("textarea").addEventListener("input", onInput);
    attach("cockpit");
    expect(query("textarea").value).toBe("Refactor the router");
    expect(query<HTMLInputElement>("[name=cwd]").value).toBe("/srv/app");
    expect(onInput).toHaveBeenCalled();
  });

  it("restores fields that render after the document loads", async () => {
    attach("cockpit");
    type(query("textarea"), "Draft");
    vi.advanceTimersByTime(500);
    detachers.pop()?.();

    document.body.innerHTML = "";
    attach("cockpit");
    document.body.innerHTML = `<textarea placeholder="Describe the task"></textarea>`;
    await vi.waitFor(() =>
      expect(query("textarea").value).toBe("Draft"),
    );
  });

  it("never overwrites text already in a field", () => {
    attach("cockpit");
    type(query("textarea"), "Old draft");
    vi.advanceTimersByTime(500);
    detachers.pop()?.();

    document.body.innerHTML = `<textarea placeholder="Describe the task">Typed already</textarea>`;
    attach("cockpit");
    expect(query("textarea").value).toBe("Typed already");
  });

  it("drops a draft once the field is cleared, as after sending", () => {
    attach("cockpit");
    const field = query("textarea");
    type(field, "Send me");
    vi.advanceTimersByTime(500);
    field.value = "";
    field.dispatchEvent(new Event("keydown", { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({});
  });

  it("drops drafts for fields no longer on screen, but only after interaction", () => {
    attach("cockpit");
    type(query("textarea"), "Modal note");
    vi.advanceTimersByTime(500);
    detachers.pop()?.();

    document.body.innerHTML = `<input name="cwd" />`;
    attach("cockpit");
    vi.advanceTimersByTime(500);
    expect(Object.keys(stored())).toHaveLength(1);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(stored()).toEqual({});
  });

  it("keeps scopes apart and discards one scope on close", () => {
    attach("cockpit");
    type(query("textarea"), "Cockpit text");
    vi.advanceTimersByTime(500);
    detachers.pop()?.();
    attach("chat");
    query("textarea").value = "";
    type(query("textarea"), "Chat text");
    vi.advanceTimersByTime(500);
    expect(Object.keys(stored())).toHaveLength(2);

    discardDrafts("cockpit", localStorage);
    expect(Object.values(stored()).map((d) => d.value)).toEqual(["Chat text"]);
  });

  it("never persists secrets or unlabeled fields", () => {
    attach("cockpit");
    for (const field of document.querySelectorAll("input")) type(field, "s3cret");
    vi.advanceTimersByTime(500);
    expect(Object.values(stored()).map((d) => d.value)).toEqual(["s3cret"]);
    expect(Object.keys(stored())[0]).toContain("cwd");
    expect(draftSignature(query<HTMLInputElement>("[name=apiKey]"))).toBeNull();
  });
});
