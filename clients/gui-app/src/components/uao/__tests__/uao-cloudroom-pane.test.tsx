import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  type CloudroomPublicConfig,
  type UaoCloudroomApi,
} from "@traycer-clients/shared/cloudroom";
import { UaoCloudroomPane } from "../uao-cloudroom-pane";

function config(tokenSaved: boolean): CloudroomPublicConfig {
  return { baseUrl: CLOUDROOM_DEFAULT_BASE_URL, tokenSaved };
}

function renderPane(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UaoCloudroomPane />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "uaoCloudroom");
});

describe("CloudRoom page", () => {
  it("shows the URL and the error when CloudRoom refuses the token", async () => {
    const health = vi.fn(() =>
      Promise.resolve({
        status: "unauthorized" as const,
        baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
        message:
          "CloudRoom refused the token. Enter the CLOUDROOM_TOKEN from the server.",
      }),
    );
    const api: UaoCloudroomApi = {
      getConfig: () => Promise.resolve(config(true)),
      setConfig: () => Promise.resolve(config(true)),
      setToken: () => Promise.resolve({ ok: true }),
      health,
      listSessions: () =>
        Promise.resolve({
          ok: true,
          value: [],
        }),
      createSession: () =>
        Promise.resolve({ ok: true, value: { sessionId: "cr_unused" } }),
      events: () => Promise.resolve({ ok: true, value: [] }),
    };
    window.uaoCloudroom = api;
    renderPane();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("CLOUDROOM_TOKEN");
    expect(alert.textContent).toContain(CLOUDROOM_DEFAULT_BASE_URL);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => {
      expect(health).toHaveBeenCalledTimes(2);
    });
    screen.getByRole("button", { name: "Endpoints" }).click();
    const base = await screen.findByLabelText("CloudRoom");
    if (!(base instanceof HTMLInputElement)) {
      throw new Error("CloudRoom field is not an input.");
    }
    expect(base.value).toBe(CLOUDROOM_DEFAULT_BASE_URL);
    const token = screen.getByLabelText(/CloudRoom token/);
    if (!(token instanceof HTMLInputElement)) {
      throw new Error("Token field is not an input.");
    }
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Saved in the keychain");
    expect(screen.getByText(/\(saved\)/)).toBeTruthy();
  });

  it("lists sessions, starts Codex, and shows polled output", async () => {
    const events = vi.fn((sessionId: string) =>
      Promise.resolve({
        ok: true as const,
        value:
          sessionId === "cr_demo"
            ? [{ sequence: 1, kind: "text_delta", text: "Hello" }]
            : [],
      }),
    );
    const api: UaoCloudroomApi = {
      getConfig: () => Promise.resolve(config(false)),
      setConfig: () => Promise.resolve(config(false)),
      setToken: () => Promise.resolve({ ok: true }),
      health: () =>
        Promise.resolve({
          status: "ready",
          baseUrl: CLOUDROOM_DEFAULT_BASE_URL,
          message: `Connected to CloudRoom at ${CLOUDROOM_DEFAULT_BASE_URL}.`,
        }),
      listSessions: () =>
        Promise.resolve({
          ok: true,
          value: [
            {
              sessionId: "cr_demo",
              harness: "codex",
              state: "idle",
              model: null,
              lastActivityMs: null,
            },
          ],
        }),
      createSession: () =>
        Promise.resolve({ ok: true, value: { sessionId: "cr_new" } }),
      events,
    };
    window.uaoCloudroom = api;
    renderPane();
    expect(
      await screen.findByText(
        `Connected to CloudRoom at ${CLOUDROOM_DEFAULT_BASE_URL}.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    (await screen.findByRole("button", { name: /cr_demo/ })).click();
    expect(await screen.findByText("Hello")).toBeTruthy();
    expect(events).toHaveBeenCalledWith("cr_demo", 0);
    screen.getByRole("button", { name: "Start" }).click();
    expect(await screen.findByText("Waiting for session output…")).toBeTruthy();
  });
});
