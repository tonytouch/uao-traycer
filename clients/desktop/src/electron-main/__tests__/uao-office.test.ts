import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { attachUaoOffice } from "../uao-office";

const boundary = vi.hoisted(() => ({
  handles: new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>(),
  listeners: new Map<string, (event: IpcMainInvokeEvent, value: unknown) => void>(),
  frame: { url: "http://127.0.0.1:5183/desktop/uao.html" },
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/tmp/uao-office-test" },
  ipcMain: {
    handle: (name: string, callback: (event: IpcMainInvokeEvent, value: unknown) => unknown) => boundary.handles.set(name, callback),
    on: (name: string, callback: (event: IpcMainInvokeEvent, value: unknown) => void) => boundary.listeners.set(name, callback),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = { mainFrame: boundary.frame };
    getContentBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
    close = vi.fn();
  },
}));
vi.mock("../app/logger", () => ({ log: { error: vi.fn() } }));

describe("UAO Office native boundary", () => {
  beforeEach(() => {
    boundary.handles.clear(); boundary.listeners.clear();
    boundary.frame.url = "http://127.0.0.1:5183/desktop/uao.html";
  });
  function setup() {
    const window = new BrowserWindow();
    const host = {
      list: vi.fn(() => []), create: vi.fn(async () => {}), browse: vi.fn(async () => {}),
      activate: vi.fn(), close: vi.fn(async () => {}), setViewport: vi.fn(),
      closeAll: vi.fn(async () => false),
    };
    attachUaoOffice(window, "http://127.0.0.1:5183", {
      prepareOfficeRuntime: () => {}, createOfficeHost: () => host,
    });
    // Electron is the external boundary; only these fields are read by the handlers.
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent;
    return { window, host, event };
  }
  it("admits the parent renderer and refuses guests, child frames and other origins", () => {
    const { host, event } = setup();
    const list = boundary.handles.get("uao-office:list")!;
    expect(list(event, undefined)).toEqual([]);
    expect(() => list({ ...event, sender: new BrowserWindow().webContents }, undefined)).toThrow("refused");
    expect(() => list({ ...event, senderFrame: { ...event.senderFrame } }, undefined)).toThrow("refused");
    boundary.frame.url = "https://other.example/";
    expect(() => list(event, undefined)).toThrow("refused");
    boundary.frame.url = "";
    expect(() => list(event, undefined)).toThrow("refused");
    expect(host.list).toHaveBeenCalledTimes(1);
  });
  it("refuses unknown formats before invoking a document engine", () => {
    const { host, event } = setup();
    const create = boundary.handles.get("uao-office:create")!;
    expect(() => create(event, "executable")).toThrow("Unknown document type");
    expect(host.create).not.toHaveBeenCalled();
    void create(event, "markdown");
    expect(host.create).toHaveBeenCalledWith("markdown");
  });
  it("clamps view placement and ignores nonfinite or unauthorized geometry", () => {
    const { host, event } = setup();
    const viewport = boundary.listeners.get("uao-office:viewport")!;
    viewport(event, { x: -40, y: 40.7, width: 5000, height: 900 });
    expect(host.setViewport).toHaveBeenLastCalledWith({ x: 0, y: 41, width: 800, height: 559 });
    viewport(event, { x: 0, y: 0, width: NaN, height: 100 });
    viewport({ ...event, sender: new BrowserWindow().webContents }, null);
    expect(host.setViewport).toHaveBeenCalledTimes(1);
    viewport(event, null);
    expect(host.setViewport).toHaveBeenLastCalledWith(null);
  });
  it("keeps the app open when the document close guard is canceled", async () => {
    const { host, window } = setup();
    const preventDefault = vi.fn();
    window.emit("close", { preventDefault });
    await vi.waitFor(() => expect(host.closeAll).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.close).not.toHaveBeenCalled();
  });
  it("closes only after document guards permit it and avoids duplicate prompts", async () => {
    const { host, window } = setup();
    host.closeAll.mockResolvedValue(true);
    window.emit("close", { preventDefault: vi.fn() });
    window.emit("close", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce());
    expect(host.closeAll).toHaveBeenCalledOnce();
  });
});
