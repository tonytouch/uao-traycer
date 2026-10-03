import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UaoActivitySource } from "../activity-source";

const connections: NativeSource[] = [];
const viewers: UaoActivitySource[] = [];
class NativeSource extends EventTarget {
  readyState = 1;
  close = vi.fn();
  constructor(readonly url: string) {
    super();
    connections.push(this);
  }
}

beforeEach(() => {
  connections.length = 0;
  vi.stubGlobal("EventSource", NativeSource);
});
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.close();
  vi.unstubAllGlobals();
});

function openViewer(): UaoActivitySource {
  const viewer = new UaoActivitySource();
  viewers.push(viewer);
  return viewer;
}

it("shares live events, replays the greeting to late tabs and detaches one viewer independently", async () => {
  const first = openViewer();
  const greeting = vi.fn();
  first.addEventListener("hello", greeting);
  connections[0].dispatchEvent(new MessageEvent("hello", { data: "connected" }));
  const second = openViewer();
  second.addEventListener("hello", greeting);
  const activity = vi.fn();
  second.addEventListener("agent_event", activity);
  await Promise.resolve();
  expect(connections).toHaveLength(1);
  expect(greeting).toHaveBeenCalledTimes(2);
  first.close();
  expect(connections[0].close).not.toHaveBeenCalled();
  connections[0].dispatchEvent(new MessageEvent("agent_event", { data: "running" }));
  expect(activity).toHaveBeenCalledOnce();
  second.close();
  expect(connections[0].close).toHaveBeenCalledOnce();
  expect(second.readyState).toBe(second.CLOSED);
});

it("does not replay stale connectivity or events from a closed connection", async () => {
  const first = openViewer();
  const original = connections[0];
  original.dispatchEvent(new MessageEvent("hello", { data: "connected" }));
  original.readyState = 0;
  original.dispatchEvent(new Event("error"));
  const second = openViewer();
  const greeting = vi.fn();
  second.addEventListener("hello", greeting);
  await Promise.resolve();
  expect(greeting).not.toHaveBeenCalled();
  first.close();
  second.close();
  const third = openViewer();
  const activity = vi.fn();
  third.addEventListener("agent_event", activity);
  original.dispatchEvent(new MessageEvent("agent_event", { data: "old" }));
  expect(activity).not.toHaveBeenCalled();
  connections[1].dispatchEvent(new MessageEvent("agent_event", { data: "new" }));
  expect(activity).toHaveBeenCalledOnce();
});
