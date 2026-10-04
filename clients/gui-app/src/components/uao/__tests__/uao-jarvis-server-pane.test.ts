import { describe, expect, it } from "vitest";
import { jarvisServerHref } from "../uao-jarvis-server-pane";

describe("jarvisServerHref", () => {
  it("deep-links the server's own Jarvis screen", () => {
    expect(jarvisServerHref("https://server.example.ts.net:10000/")).toBe(
      "https://server.example.ts.net:10000/uao-api/#/jarvis",
    );
  });
});
