// The built UAO shell opens this same feed in every document. Retained tabs
// share it so six HTTP/1 connections cannot block the next tab's assets/API.
const viewers = new Set<UaoActivitySource>();
let source: EventSource | null = null;
let hello: MessageEvent | null = null;

function copyEvent(event: Event): Event {
  const data: unknown = event instanceof MessageEvent ? event.data : null;
  return event instanceof MessageEvent
    ? new MessageEvent(event.type, {
        data,
        origin: event.origin,
        lastEventId: event.lastEventId,
      })
    : new Event(event.type);
}

// Installed in place of the browser EventSource, so it mirrors the handler and
// state surface but cannot structurally implement EventTarget's typed overloads.
export class UaoActivitySource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url = new URL("/api/agents/activity", window.location.href).href;
  readonly withCredentials = false;
  onopen: ((this: UaoActivitySource, event: Event) => unknown) | null = null;
  onerror: ((this: UaoActivitySource, event: Event) => unknown) | null = null;
  onmessage: ((this: UaoActivitySource, event: MessageEvent) => unknown) | null = null;
  private closed = false;

  constructor() {
    super();
    this.addEventListener("open", (event) => {
      this.onopen?.call(this, event);
    });
    this.addEventListener("error", (event) => {
      this.onerror?.call(this, event);
    });
    this.addEventListener("message", (event) => {
      if (event instanceof MessageEvent) this.onmessage?.call(this, event);
    });
    viewers.add(this);
    if (source === null) {
      const connection = new EventSource(this.url);
      source = connection;
      for (const type of ["open", "error", "message", "hello", "agent_event"]) {
        connection.addEventListener(type, (event) => {
          if (source !== connection) return;
          if (type === "error") hello = null;
          if (type === "hello" && event instanceof MessageEvent) hello = event;
          for (const viewer of viewers) viewer.deliver(event);
        });
      }
    } else {
      queueMicrotask(() => {
        if (source?.readyState === this.OPEN) this.deliver(new Event("open"));
        if (hello !== null) this.deliver(hello);
      });
    }
  }

  get readyState(): number {
    return this.closed ? this.CLOSED : (source?.readyState ?? this.CLOSED);
  }

  private deliver(event: Event): void {
    if (this.closed) return;
    const copy = copyEvent(event);
    this.dispatchEvent(copy);
  }

  close(): void {
    this.closed = true;
    viewers.delete(this);
    if (viewers.size === 0) {
      source?.close();
      source = null;
      hello = null;
    }
  }
}
