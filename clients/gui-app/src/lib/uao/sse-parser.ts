export interface HermesSSEEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface SseParser {
  readonly feed: (chunk: string) => void;
  readonly reset: () => void;
  readonly getPendingBuffer: () => string;
}

/**
 * Creates a streaming Server-Sent Events (SSE) parser that handles arbitrary chunk
 * boundaries, CRLF/LF newlines, multi-line data payloads, and malformed frames.
 */
export function createSseParser(
  onEvent: (evt: HermesSSEEvent) => void,
): SseParser {
  let buffer = "";

  return {
    feed(chunk: string): void {
      buffer += chunk;
      buffer = buffer.replace(/\r\n/g, "\n");

      let sepIndex = buffer.indexOf("\n\n");
      while (sepIndex !== -1) {
        const frame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        if (frame.trim().length === 0) continue;

        let eventName = "message";
        const dataLines: string[] = [];

        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length === 0) continue;
        const dataString = dataLines.join("\n");

        try {
          const parsed: unknown = JSON.parse(dataString);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            onEvent({
              event: eventName,
              data: parsed as Record<string, unknown>,
            });
          }
        } catch {
          // Skip malformed JSON without corrupting the parser stream
        }

        sepIndex = buffer.indexOf("\n\n");
      }
    },
    reset(): void {
      buffer = "";
    },
    getPendingBuffer(): string {
      return buffer;
    },
  };
}

/**
 * Convenience helper to parse a complete string containing one or more SSE frames.
 */
export function parseSseFrames(input: string): readonly HermesSSEEvent[] {
  const events: HermesSSEEvent[] = [];
  const parser = createSseParser((evt) => {
    events.push(evt);
  });
  parser.feed(input);
  return events;
}
