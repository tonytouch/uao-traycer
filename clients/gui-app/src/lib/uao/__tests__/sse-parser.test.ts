import { describe, expect, it } from "vitest";
import { createSseParser, type HermesSSEEvent } from "../sse-parser";

describe("Hermes SSE Parser", () => {
  it("dispatches assistant delta and completion events in order across fragmented chunks", () => {
    const events: HermesSSEEvent[] = [];
    const parser = createSseParser((evt) => {
      events.push(evt);
    });

    // Chunk 1: fragment of assistant.delta event and data
    parser.feed('event: assistant.delta\ndata: {"del');
    expect(events).toEqual([]);

    // Chunk 2: remainder of delta json, delimiter, and start of completion event
    parser.feed('ta":"Hello"}\n\nevent: assistant.com');
    expect(events).toEqual([
      {
        event: "assistant.delta",
        data: { delta: "Hello" },
      },
    ]);

    // Chunk 3: rest of completion event and double newline
    parser.feed('pleted\ndata: {"content":"Hello"}\n\n');
    expect(events).toEqual([
      {
        event: "assistant.delta",
        data: { delta: "Hello" },
      },
      {
        event: "assistant.completed",
        data: { content: "Hello" },
      },
    ]);
  });
});
