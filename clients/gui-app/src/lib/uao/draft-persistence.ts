// Keep unsent text in UAO's embedded documents across a desktop restart. The
// stored set mirrors what is on screen: a field that is cleared (sent) or no
// longer rendered drops its draft, the same as switching tabs in one session.

const STORAGE_KEY = "uao-desktop-drafts:v1";
const MAX_DRAFTS = 300;
const MAX_VALUE_LENGTH = 100_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TEXT_TYPES = new Set(["", "text", "search", "url", "email", "tel"]);
const SENSITIVE =
  /pass(word|code|phrase)?|secret|token|api[\s_-]?key|credential|otp|private[\s_-]?key|\bpin\b/i;

interface DraftRecord {
  readonly value: string;
  readonly at: number;
}
type DraftStore = Record<string, DraftRecord>;
type DraftField = HTMLInputElement | HTMLTextAreaElement;

function isDraftRecord(record: unknown): record is DraftRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    "value" in record &&
    typeof record.value === "string" &&
    "at" in record &&
    typeof record.at === "number"
  );
}

function readStore(storage: Storage): DraftStore {
  try {
    const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    const store: DraftStore = {};
    for (const [key, record] of Object.entries(raw)) {
      if (isDraftRecord(record)) store[key] = { value: record.value, at: record.at };
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(storage: Storage, store: DraftStore, now: number): void {
  const entries = Object.entries(store)
    .filter(([, record]) => now - record.at < MAX_AGE_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_DRAFTS);
  try {
    if (entries.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage full or unavailable: drafts stay session-only.
  }
}

// Elements belong to the frame's realm, so tag names stand in for instanceof.
function asDraftField(element: Element): DraftField | null {
  const tag = element.tagName;
  if (tag === "TEXTAREA") return element as HTMLTextAreaElement;
  if (tag !== "INPUT") return null;
  const input = element as HTMLInputElement;
  return TEXT_TYPES.has(input.type.toLowerCase()) ? input : null;
}

/** Stable identity for a field, or null when it should never be persisted. */
export function draftSignature(field: DraftField): string | null {
  if (field.disabled || field.readOnly || field.closest("[data-no-draft]")) {
    return null;
  }
  const label = [
    field.name,
    field.id,
    field.getAttribute("placeholder") ?? "",
    field.getAttribute("aria-label") ?? "",
  ];
  if (label.every((part) => part === "")) return null;
  const autocomplete = field.getAttribute("autocomplete") ?? "";
  if (/password|one-time-code|cc-/i.test(autocomplete)) return null;
  if (label.some((part) => SENSITIVE.test(part))) return null;
  return [field.tagName, field.type, ...label].join("|");
}

function fieldsByKey(doc: Document, prefix: string): Map<string, DraftField> {
  const ordinals = new Map<string, number>();
  const fields = new Map<string, DraftField>();
  for (const element of doc.querySelectorAll("input, textarea")) {
    const field = asDraftField(element);
    const signature = field && draftSignature(field);
    if (!field || !signature) continue;
    const ordinal = ordinals.get(signature) ?? 0;
    ordinals.set(signature, ordinal + 1);
    fields.set(`${prefix}${signature}#${ordinal}`, field);
  }
  return fields;
}

// React tracks the instance value; the prototype setter plus an input event
// updates controlled components the same way typing does.
function fillField(field: DraftField, value: string): void {
  const proto = Object.getPrototypeOf(field) as object | null;
  if (!proto || !Reflect.set(proto, "value", value, field)) field.value = value;
  const EventCtor = field.ownerDocument.defaultView?.Event ?? Event;
  field.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

export interface DraftPersistenceOptions {
  /** Owner of the document, e.g. a feature tab or the dedicated chat. */
  readonly scope: () => string;
  readonly storage?: Storage;
  readonly now?: () => number;
}

/**
 * Restore and record drafts for one same-origin embedded document. Returns a
 * cleanup function. Drafts are only removed after the user has interacted
 * with this document, so lazily rendered fields get a chance to appear.
 */
export function attachDraftPersistence(
  doc: Document,
  { scope, storage = window.localStorage, now = Date.now }: DraftPersistenceOptions,
): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  const restored = new WeakSet<DraftField>();
  let interacted = false;
  let timer: number | undefined;

  const scopePrefix = () => `${scope()}\u0000`;
  const routePrefix = () => `${scopePrefix()}${view.location.hash}\u0000`;

  const restore = () => {
    const store = readStore(storage);
    for (const [key, field] of fieldsByKey(doc, routePrefix())) {
      if (restored.has(field)) continue;
      restored.add(field);
      if (field.value === "" && Object.hasOwn(store, key)) {
        fillField(field, store[key].value);
      }
    }
  };

  const snapshot = () => {
    window.clearTimeout(timer);
    const store = readStore(storage);
    const time = now();
    const present = fieldsByKey(doc, routePrefix());
    if (interacted) {
      const prefix = scopePrefix();
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix) && !present.has(key)) delete store[key];
      }
    }
    for (const [key, field] of present) {
      const value = field.value;
      if (value.trim() !== "" && value.length <= MAX_VALUE_LENGTH) {
        store[key] = { value, at: time };
      } else if (interacted) {
        delete store[key];
      }
    }
    writeStore(storage, store, time);
  };

  const schedule = (delay: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(snapshot, delay);
  };
  const onInteraction = () => {
    interacted = true;
    schedule(400);
  };
  const onInput = (event: Event) => {
    if (event.isTrusted) interacted = true;
    schedule(250);
  };
  const observer = new MutationObserver(() => {
    if (!interacted) restore();
    schedule(400);
  });

  restore();
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("pointerdown", onInteraction, true);
  doc.addEventListener("keydown", onInteraction, true);
  view.addEventListener("pagehide", snapshot);
  view.addEventListener("hashchange", restore);

  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("pointerdown", onInteraction, true);
    doc.removeEventListener("keydown", onInteraction, true);
    view.removeEventListener("pagehide", snapshot);
    view.removeEventListener("hashchange", restore);
  };
}

/** Forget a scope's drafts, e.g. when its tab is explicitly closed. */
export function discardDrafts(scope: string, storage: Storage): void {
  const store = readStore(storage);
  const prefix = `${scope}\u0000`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) delete store[key];
  }
  writeStore(storage, store, Date.now());
}
