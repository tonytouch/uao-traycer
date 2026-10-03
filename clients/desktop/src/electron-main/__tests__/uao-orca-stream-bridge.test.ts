import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { URL } from "node:url";
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  decodeTerminalStreamJson,
  encodeTerminalStreamText,
  decodeTerminalStreamText,
} from "@traycer-clients/shared/uao/orca-stream-protocol";
import {
  createWebSocketAccept,
  encodeWebSocketFrame,
  encodeWebSocketCloseFrame,
  encodeClientMaskedWebSocketFrame,
  WebSocketFrameParser,
  WebSocketProtocolError,
  WsOpcode,
} from "../uao-rfc6455";
import {
  handleOrcaTerminalStreamUpgrade,
  type RemoteRuntimeSubscriptionHandle,
  type RemoteRuntimeSubscriptionCallbacks,
  type SubscribeRemoteRuntimeFn,
} from "../uao-orca-adapter";
import { startUaoServer, type UaoServerInstance } from "../uao-server";

interface FakeSocketOptions {
  readonly onWrite?: ((chunk: Buffer | string) => void) | undefined;
}

function createFakeSocket(options: FakeSocketOptions | undefined): {
  readonly socket: net.Socket;
  readonly written: Buffer[];
  readonly isDestroyed: () => boolean;
} {
  const written: Buffer[] = [];
  let destroyed = false;
  const socket = new net.Socket();

  socket.write = (data: Uint8Array | string): boolean => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    written.push(buf);
    options?.onWrite?.(buf);
    return true;
  };

  const origDestroy = socket.destroy.bind(socket);
  socket.destroy = (error: Error | undefined): net.Socket => {
    destroyed = true;
    socket.emit("close");
    return origDestroy(error);
  };

  const origEnd = socket.end.bind(socket);
  socket.end = (): net.Socket => {
    destroyed = true;
    socket.emit("close");
    return origEnd();
  };

  return {
    socket,
    written,
    isDestroyed: () => destroyed,
  };
}

function createFakeRequest(
  headers: http.IncomingHttpHeaders,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new net.Socket());
  req.headers = { "sec-websocket-version": "13", ...headers };
  return req;
}

describe("Orca Stream Protocol Framing", () => {
  it("encodes and decodes binary frames accurately", () => {
    const text = "echo 'hello terminal'\n";
    const payload = encodeTerminalStreamText(text);
    const frame = {
      opcode: TerminalStreamOpcode.Input,
      streamId: 1,
      seq: 42,
      payload,
    };

    const encoded = encodeTerminalStreamFrame(frame);
    expect(encoded.length).toBe(16 + payload.length);
    expect(encoded[0]).toBe(0x74); // kind
    expect(encoded[1]).toBe(1); // version
    expect(encoded[2]).toBe(TerminalStreamOpcode.Input);
    expect(encoded[3]).toBe(0); // reserved byte

    const decoded = decodeTerminalStreamFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.opcode).toBe(TerminalStreamOpcode.Input);
    expect(decoded?.streamId).toBe(1);
    expect(decoded?.seq).toBe(42);
    expect(decodeTerminalStreamText(decoded!.payload)).toBe(text);
  });

  it("handles 64-bit sequence numbers correctly", () => {
    const largeSeq = 0x100000000 * 5 + 12345;
    const frame = {
      opcode: TerminalStreamOpcode.Output,
      streamId: 1,
      seq: largeSeq,
      payload: new Uint8Array([1, 2, 3]),
    };
    const encoded = encodeTerminalStreamFrame(frame);
    const decoded = decodeTerminalStreamFrame(encoded);
    expect(decoded?.seq).toBe(largeSeq);
  });

  it("rejects truncated or malformed frames", () => {
    expect(decodeTerminalStreamFrame(new Uint8Array(10))).toBeNull();
    const badKind = new Uint8Array(20);
    badKind[0] = 0x00;
    badKind[1] = 1;
    expect(decodeTerminalStreamFrame(badKind)).toBeNull();

    const badOpcode = new Uint8Array(20);
    badOpcode[0] = 0x74;
    badOpcode[1] = 1;
    badOpcode[2] = 99;
    expect(decodeTerminalStreamFrame(badOpcode)).toBeNull();

    const badReserved = new Uint8Array(20);
    badReserved[0] = 0x74;
    badReserved[1] = 1;
    badReserved[2] = TerminalStreamOpcode.Input;
    badReserved[3] = 0xff; // reserved byte not 0
    expect(decodeTerminalStreamFrame(badReserved)).toBeNull();
  });

  it("encodes and decodes JSON structures within limits", () => {
    const data = { cols: 120, rows: 40 };
    const encoded = encodeTerminalStreamJson(data);
    const decoded = decodeTerminalStreamJson<{ cols: number; rows: number }>(
      encoded,
    );
    expect(decoded).toEqual(data);
  });
});

describe("RFC 6455 Frame Parser & Mask Enforcement", () => {
  it("computes standard WebSocket accept key", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    const accept = createWebSocketAccept(key);
    expect(accept).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("parses valid masked binary frame from client", () => {
    const parser = new WebSocketFrameParser();
    const rawPayload = Buffer.from([10, 20, 30, 40]);
    const frame = encodeClientMaskedWebSocketFrame(
      rawPayload,
      WsOpcode.Binary,
      undefined,
      undefined,
      undefined,
    );

    const parsed = parser.push(frame);
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.fin).toBe(true);
    expect(parsed[0]?.opcode).toBe(WsOpcode.Binary);
    expect(parsed[0]?.payload).toEqual(rawPayload);
  });

  it("rejects unmasked client frame with protocol error 1002", () => {
    const parser = new WebSocketFrameParser();
    const rawPayload = Buffer.from([1, 2, 3]);
    const unmaskedFrame = encodeWebSocketFrame(rawPayload, WsOpcode.Binary);

    expect(() => parser.push(unmaskedFrame)).toThrow(WebSocketProtocolError);
    try {
      parser.push(unmaskedFrame);
    } catch (err) {
      expect((err as WebSocketProtocolError).closeCode).toBe(1002);
    }
  });

  it("rejects frames with non-zero RSV bits with code 1002", () => {
    const parser = new WebSocketFrameParser();
    const payload = Buffer.from("hello");
    // RSV = 1 (bit 6)
    const badRsvFrame = encodeClientMaskedWebSocketFrame(
      payload,
      WsOpcode.Text,
      Buffer.from([1, 2, 3, 4]),
      true,
      1,
    );
    expect(() => parser.push(badRsvFrame)).toThrow(WebSocketProtocolError);
  });

  it("rejects fragmented messages safely with code 1003", () => {
    const parser = new WebSocketFrameParser();
    const payload = Buffer.from("chunk");
    // FIN = false
    const fragmentedFrame = encodeClientMaskedWebSocketFrame(
      payload,
      WsOpcode.Binary,
      Buffer.from([1, 2, 3, 4]),
      false,
      undefined,
    );
    try {
      parser.push(fragmentedFrame);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebSocketProtocolError);
      expect((err as WebSocketProtocolError).closeCode).toBe(1003);
    }
  });

  it("rejects control frame violation (fragmented or > 125 bytes) with code 1002", () => {
    const parser = new WebSocketFrameParser();
    const payload = Buffer.alloc(130);
    const oversizedPing = encodeClientMaskedWebSocketFrame(
      payload,
      WsOpcode.Ping,
      Buffer.from([1, 2, 3, 4]),
      true,
      undefined,
    );
    expect(() => parser.push(oversizedPing)).toThrow(WebSocketProtocolError);
  });
});

describe("Orca Terminal Stream Bridge Unit Tests", () => {
  function setupTestUserDataDir(): {
    readonly tmpDir: string;
    readonly cleanup: () => void;
  } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uao-stream-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "orca-runtime.json"),
      JSON.stringify({
        runtimeId: "rt_test_unit",
        pid: process.pid,
        transports: [{ kind: "websocket", endpoint: "ws://127.0.0.1:36439" }],
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "orca-devices.json"),
      JSON.stringify([
        {
          deviceId: "dev_1",
          name: "Test Runtime",
          token: "secret-token-do-not-leak",
          scope: "runtime",
        },
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, "orca-e2ee-keypair.json"),
      JSON.stringify({
        publicKeyB64: "dGVzdC1wdWJsaWMta2V5LWZvci10ZXN0",
      }),
    );

    return {
      tmpDir,
      cleanup: () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it("rejects invalid or missing terminal handles with 400 Bad Request", async () => {
    const { socket, written, isDestroyed } = createFakeSocket(undefined);
    const req = createFakeRequest({
      host: "127.0.0.1:4000",
      origin: "http://127.0.0.1:4000",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    });

    await handleOrcaTerminalStreamUpgrade(req, socket, Buffer.alloc(0), {
      port: 4000,
      serverOrigin: "http://127.0.0.1:4000",
      parsedUrl: new URL(
        "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=invalid;rm",
      ),
    });

    expect(isDestroyed()).toBe(true);
    const output = Buffer.concat(written).toString();
    expect(output).toContain("400 Bad Request");
    expect(output).toContain("Invalid terminal handle");
  });

  it("rejects malformed WebSocket keys before opening upstream", async () => {
    const { socket, written } = createFakeSocket(undefined);
    await handleOrcaTerminalStreamUpgrade(
      createFakeRequest({ "sec-websocket-key": "testkey==" }),
      socket,
      Buffer.alloc(0),
      {
        port: 4000,
        serverOrigin: "http://127.0.0.1:4000",
        parsedUrl: new URL(
          "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
        ),
      },
    );
    expect(Buffer.concat(written).toString()).toContain("400 Bad Request");
  });

  it("waits for multiplex ready with runtime identity fencing before 101 and subscribe", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket, written } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let capturedCallbacks!: RemoteRuntimeSubscriptionCallbacks;
      const sentToUpstream: Uint8Array[] = [];

      const mockSubscribe: SubscribeRemoteRuntimeFn = async (
        _pairing,
        _method,
        _params,
        _timeoutMs,
        callbacks,
      ) => {
        capturedCallbacks = callbacks;
        return {
          requestId: "req_test",
          close: () => {},
          sendBinary: (b) => {
            sentToUpstream.push(b);
            return true;
          },
        };
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
        },
      );

      // Before onResponse: HTTP 101 must NOT have been sent yet
      await new Promise((r) => setTimeout(r, 20));
      expect(Buffer.concat(written).toString()).not.toContain(
        "101 Switching Protocols",
      );
      expect(sentToUpstream.length).toBe(0);

      // Signal successful multiplex ready response with pinned runtime ID
      capturedCallbacks.onResponse({
        id: "req_test",
        ok: true,
        result: { ready: true },
        _meta: { runtimeId: "rt_test_unit" },
      });

      await upgradePromise;

      const output = Buffer.concat(written).toString();
      expect(output).toContain("101 Switching Protocols");
      expect(output).toContain(
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      );

      // Initial Subscribe frame sent with capabilities
      expect(sentToUpstream.length).toBe(1);
      const subFrame = decodeTerminalStreamFrame(sentToUpstream[0]!);
      expect(subFrame?.opcode).toBe(TerminalStreamOpcode.Subscribe);
    } finally {
      cleanup();
    }
  });

  it("handles upstream sendBinary returning false with client disconnect", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket, written, isDestroyed } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let capturedCallbacks!: RemoteRuntimeSubscriptionCallbacks;
      const mockSubscribe: SubscribeRemoteRuntimeFn = async (
        _p,
        _m,
        _params,
        _t,
        callbacks,
      ) => {
        capturedCallbacks = callbacks;
        return {
          requestId: "req_test",
          close: () => {},
          // Always return false to simulate upstream queue full / write failure
          sendBinary: () => false,
        };
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
        },
      );

      capturedCallbacks.onResponse({
        id: "req_test",
        ok: true,
        result: { ready: true },
        _meta: { runtimeId: "rt_test_unit" },
      });

      await upgradePromise;
      // Because initial subscribe failed to send (sendBinary returned false), client is closed
      expect(isDestroyed()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("negotiates desktopViewportClaims and sets real dimensions in initial Subscribe frame", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let capturedCallbacks!: RemoteRuntimeSubscriptionCallbacks;
      const sentToUpstream: Uint8Array[] = [];

      const mockSubscribe: SubscribeRemoteRuntimeFn = async (
        _p,
        _m,
        _params,
        _t,
        callbacks,
      ) => {
        capturedCallbacks = callbacks;
        return {
          requestId: "req_test",
          close: () => {},
          sendBinary: (b) => {
            sentToUpstream.push(b);
            return true;
          },
        };
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
          initialViewport: { cols: 120, rows: 45 },
        },
      );

      capturedCallbacks.onResponse({
        id: "req_test",
        ok: true,
        result: { ready: true },
        _meta: { runtimeId: "rt_test_unit" },
      });

      await upgradePromise;

      expect(sentToUpstream.length).toBe(1);
      const subFrame = decodeTerminalStreamFrame(sentToUpstream[0]!);
      expect(subFrame?.opcode).toBe(TerminalStreamOpcode.Subscribe);
      const payload = decodeTerminalStreamJson<{
        readonly viewport?: { readonly cols: number; readonly rows: number };
        readonly capabilities?: {
          readonly ackOutput?: number;
          readonly desktopViewportClaims?: number;
        };
      }>(subFrame!.payload);
      expect(payload?.viewport).toEqual({ cols: 120, rows: 45 });
      expect(payload?.capabilities?.ackOutput).toBe(1);
      expect(payload?.capabilities?.desktopViewportClaims).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("forwards masked ClaimViewport and Resize frames with real dimensions", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let capturedCallbacks!: RemoteRuntimeSubscriptionCallbacks;
      const sentToUpstream: Uint8Array[] = [];

      const mockSubscribe: SubscribeRemoteRuntimeFn = async (
        _p,
        _m,
        _params,
        _t,
        callbacks,
      ) => {
        capturedCallbacks = callbacks;
        return {
          requestId: "req_test",
          close: () => {},
          sendBinary: (b) => {
            sentToUpstream.push(b);
            return true;
          },
        };
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
        },
      );

      capturedCallbacks.onResponse({
        id: "req_test",
        ok: true,
        result: { ready: true },
        _meta: { runtimeId: "rt_test_unit" },
      });

      await upgradePromise;

      // Simulate client sending masked ClaimViewport frame with real dimensions (140x50)
      const claimPayload = encodeTerminalStreamJson({ cols: 140, rows: 50 });
      const claimFrame = encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.ClaimViewport,
        streamId: 1,
        seq: 0,
        payload: claimPayload,
      });
      const maskedClaim = encodeClientMaskedWebSocketFrame(
        claimFrame,
        WsOpcode.Binary,
        undefined,
        undefined,
        undefined,
      );
      socket.emit("data", maskedClaim);

      // Simulate client sending masked Resize frame (140x50)
      const resizeFrame = encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Resize,
        streamId: 1,
        seq: 0,
        payload: claimPayload,
      });
      const maskedResize = encodeClientMaskedWebSocketFrame(
        resizeFrame,
        WsOpcode.Binary,
        undefined,
        undefined,
        undefined,
      );
      socket.emit("data", maskedResize);

      // Upstream must have received: [0: initial Subscribe, 1: ClaimViewport, 2: Resize]
      expect(sentToUpstream.length).toBe(3);
      const decodedClaim = decodeTerminalStreamFrame(sentToUpstream[1]!);
      expect(decodedClaim?.opcode).toBe(TerminalStreamOpcode.ClaimViewport);
      expect(decodeTerminalStreamJson(decodedClaim!.payload)).toEqual({
        cols: 140,
        rows: 50,
      });

      const decodedResize = decodeTerminalStreamFrame(sentToUpstream[2]!);
      expect(decodedResize?.opcode).toBe(TerminalStreamOpcode.Resize);
      expect(decodeTerminalStreamJson(decodedResize!.payload)).toEqual({
        cols: 140,
        rows: 50,
      });
    } finally {
      cleanup();
    }
  });

  it("handles upstream multiplex rejection or runtimeId mismatch by closing client without 101", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket, written, isDestroyed } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let capturedCallbacks!: RemoteRuntimeSubscriptionCallbacks;
      let closedUpstream = false;

      const mockSubscribe: SubscribeRemoteRuntimeFn = async (
        _p,
        _m,
        _params,
        _t,
        callbacks,
      ) => {
        capturedCallbacks = callbacks;
        return {
          requestId: "req_test",
          close: () => {
            closedUpstream = true;
          },
          sendBinary: () => true,
        };
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
        },
      );

      // Upstream returns mismatching runtimeId
      capturedCallbacks.onResponse({
        id: "req_test",
        ok: true,
        result: { ready: true },
        _meta: { runtimeId: "wrong_runtime_id" },
      });

      await upgradePromise;

      expect(Buffer.concat(written).toString()).not.toContain(
        "101 Switching Protocols",
      );
      expect(Buffer.concat(written).toString()).toContain("502 Bad Gateway");
      expect(isDestroyed()).toBe(true);
      expect(closedUpstream).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("cleans up late upstream subscription if client disconnects before resolve", async () => {
    const { tmpDir, cleanup } = setupTestUserDataDir();
    try {
      const { socket } = createFakeSocket(undefined);
      const req = createFakeRequest({
        host: "127.0.0.1:4000",
        origin: "http://127.0.0.1:4000",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      });

      let closedUpstream = false;
      let resolveSubscribe!: (val: RemoteRuntimeSubscriptionHandle) => void;

      const mockSubscribe: SubscribeRemoteRuntimeFn = async () => {
        return new Promise<RemoteRuntimeSubscriptionHandle>((resolve) => {
          resolveSubscribe = resolve;
        });
      };

      const upgradePromise = handleOrcaTerminalStreamUpgrade(
        req,
        socket,
        Buffer.alloc(0),
        {
          port: 4000,
          serverOrigin: "http://127.0.0.1:4000",
          parsedUrl: new URL(
            "http://127.0.0.1:4000/uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1",
          ),
          userDataPath: tmpDir,
          subscribeRuntimeImpl: mockSubscribe,
        },
      );

      // Client socket drops while awaiting subscription
      socket.destroy();

      // Later, upstream subscription resolves
      resolveSubscribe({
        requestId: "late_req",
        close: () => {
          closedUpstream = true;
        },
        sendBinary: () => true,
      });

      await upgradePromise;
      expect(closedUpstream).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("startUaoServer WebSocket Upgrade Security & Rejection", () => {
  let uaoServer: UaoServerInstance;
  let tempStaticDir: string;
  let tempUserDataDir: string;

  beforeAll(async () => {
    tempStaticDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "uao-srv-test-static-"),
    );
    fs.writeFileSync(
      path.join(tempStaticDir, "uao.html"),
      "<!doctype html><html><body>UAO</body></html>",
    );

    tempUserDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "uao-srv-test-ud-"),
    );
    fs.writeFileSync(
      path.join(tempUserDataDir, "orca-runtime.json"),
      JSON.stringify({
        runtimeId: "rt_srv_test",
        pid: process.pid,
        transports: [{ kind: "websocket", endpoint: "ws://127.0.0.1:36439" }],
      }),
    );
    fs.writeFileSync(
      path.join(tempUserDataDir, "orca-devices.json"),
      JSON.stringify([
        {
          deviceId: "dev_srv",
          name: "Server Test",
          token: "secret-token",
          scope: "runtime",
        },
      ]),
    );
    fs.writeFileSync(
      path.join(tempUserDataDir, "orca-e2ee-keypair.json"),
      JSON.stringify({
        publicKeyB64: "dGVzdC1wdWJsaWMta2V5",
      }),
    );

    uaoServer = await startUaoServer({
      staticDir: tempStaticDir,
      backendPort: 5050,
    });
  });

  afterAll(async () => {
    await uaoServer.close();
    fs.rmSync(tempStaticDir, { recursive: true, force: true });
    fs.rmSync(tempUserDataDir, { recursive: true, force: true });
  });

  function sendRawHttpRequest(
    rawRequest: string,
    port: number,
  ): Promise<{ readonly response: string; readonly closed: boolean }> {
    return new Promise((resolve) => {
      const client = net.createConnection({ port, host: "127.0.0.1" }, () => {
        client.write(rawRequest);
      });

      let response = "";
      client.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });

      client.on("close", () => {
        resolve({ response, closed: true });
      });

      client.on("error", () => {
        resolve({ response, closed: true });
      });

      setTimeout(() => {
        client.destroy();
        resolve({ response, closed: true });
      }, 500);
    });
  }

  it("rejects WebSocket upgrade with invalid Host header", async () => {
    const rawReq =
      `GET /uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1 HTTP/1.1\r\n` +
      `Host: evil-attacker.com:${uaoServer.port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const result = await sendRawHttpRequest(rawReq, uaoServer.port);
    // Connection must be terminated without 101 Switching Protocols
    expect(result.response).not.toContain("101 Switching Protocols");
    expect(result.closed).toBe(true);
  });

  it("rejects WebSocket upgrade with cross-origin Origin header", async () => {
    const rawReq =
      `GET /uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${uaoServer.port}\r\n` +
      `Origin: http://malicious-website.com\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const result = await sendRawHttpRequest(rawReq, uaoServer.port);
    expect(result.response).not.toContain("101 Switching Protocols");
    expect(result.closed).toBe(true);
  });

  it("rejects WebSocket upgrade with Sec-Fetch-Site: cross-site", async () => {
    const rawReq =
      `GET /uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${uaoServer.port}\r\n` +
      `Origin: http://127.0.0.1:${uaoServer.port}\r\n` +
      `Sec-Fetch-Site: cross-site\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const result = await sendRawHttpRequest(rawReq, uaoServer.port);
    expect(result.response).not.toContain("101 Switching Protocols");
    expect(result.closed).toBe(true);
  });

  it("rejects WebSocket upgrade with invalid Referer", async () => {
    const rawReq =
      `GET /uao-api/orca/terminal/stream?terminal=local%3A%40%40terminal-1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${uaoServer.port}\r\n` +
      `Origin: http://127.0.0.1:${uaoServer.port}\r\n` +
      `Referer: http://attacker-site.com/exploit\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const result = await sendRawHttpRequest(rawReq, uaoServer.port);
    expect(result.response).not.toContain("101 Switching Protocols");
    expect(result.closed).toBe(true);
  });

  it("rejects WebSocket upgrade when terminal handle is missing", async () => {
    const rawReq =
      `GET /uao-api/orca/terminal/stream HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${uaoServer.port}\r\n` +
      `Origin: http://127.0.0.1:${uaoServer.port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;

    const result = await sendRawHttpRequest(rawReq, uaoServer.port);
    expect(result.response).toContain("400 Bad Request");
    expect(result.response).toContain("Invalid terminal handle");
  });
});
