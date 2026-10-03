import crypto from "node:crypto";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const WS_MAX_CLIENT_FRAME_BYTES = 1024 * 1024; // 1MB bound for incoming client frames
export const WS_MAX_SOCKET_BUFFER_BYTES = 512 * 1024; // 512KB backpressure threshold

export enum WsOpcode {
  Continuation = 0x00,
  Text = 0x01,
  Binary = 0x02,
  Close = 0x08,
  Ping = 0x09,
  Pong = 0x0a,
}

export class WebSocketProtocolError extends Error {
  constructor(
    public readonly closeCode: number,
    message: string,
  ) {
    super(message);
    this.name = "WebSocketProtocolError";
  }
}

export interface WsParsedFrame {
  readonly fin: boolean;
  readonly opcode: WsOpcode;
  readonly payload: Buffer;
}

export function createWebSocketAccept(secWebSocketKey: string): string {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey + WS_GUID)
    .digest("base64");
}

export function encodeWebSocketFrame(
  payload: Uint8Array,
  opcode: WsOpcode,
): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([
    header,
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
  ]);
}

export function encodeClientMaskedWebSocketFrame(
  payload: Uint8Array,
  opcode: WsOpcode,
  maskKey: Buffer | undefined,
  fin: boolean | undefined,
  rsv: number | undefined,
): Buffer {
  const actualMask = maskKey ?? Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const actualFin = fin ?? true;
  const actualRsv = rsv ?? 0;
  const len = payload.length;
  let header: Buffer;

  const b0 =
    (actualFin ? 0x80 : 0x00) | ((actualRsv & 0x07) << 4) | (opcode & 0x0f);

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = b0;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = b0;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = b0;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    const b = payload[i];
    const m = actualMask[i % 4];
    if (b !== undefined && m !== undefined) {
      masked[i] = b ^ m;
    }
  }

  return Buffer.concat([header, actualMask.subarray(0, 4), masked]);
}

export function encodeWebSocketCloseFrame(code: number): Buffer {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code, 0);
  return encodeWebSocketFrame(payload, WsOpcode.Close);
}

export class WebSocketFrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  public push(chunk: Buffer): WsParsedFrame[] {
    if (chunk.length === 0) return [];
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames: WsParsedFrame[] = [];

    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      if (b0 === undefined || b1 === undefined) break;

      const fin = (b0 & 0x80) !== 0;
      const rsv = (b0 & 0x70) >> 4;
      const opcode = (b0 & 0x0f) as WsOpcode;
      const masked = (b1 & 0x80) !== 0;
      const basicLen = b1 & 0x7f;

      // RFC 6455 §5.1: Client-to-server frames MUST be masked.
      if (!masked) {
        throw new WebSocketProtocolError(1002, "Client frames must be masked");
      }

      // RFC 6455 §5.2: RSV bits MUST be 0 unless an extension is negotiated.
      if (rsv !== 0) {
        throw new WebSocketProtocolError(1002, "RSV bits must be 0");
      }

      if (
        ![
          WsOpcode.Binary,
          WsOpcode.Close,
          WsOpcode.Ping,
          WsOpcode.Pong,
          WsOpcode.Continuation,
        ].includes(opcode)
      ) {
        throw new WebSocketProtocolError(
          1003,
          "Only binary terminal messages are supported",
        );
      }

      const isControl = (opcode & 0x08) !== 0;

      // RFC 6455 §5.5: Control frames MUST NOT be fragmented and payload <= 125 bytes.
      if (isControl) {
        if (!fin) {
          throw new WebSocketProtocolError(
            1002,
            "Control frames must not be fragmented",
          );
        }
        if (basicLen > 125) {
          throw new WebSocketProtocolError(
            1002,
            "Control frame payload exceeds 125 bytes",
          );
        }
      } else {
        // Safe fragmentation enforcement: explicitly refuse fragmented messages
        if (!fin || opcode === WsOpcode.Continuation) {
          throw new WebSocketProtocolError(
            1003,
            "Fragmented messages are not supported",
          );
        }
      }

      let offset = 2;
      let payloadLen = basicLen;

      if (basicLen === 126) {
        if (this.buffer.length < 4) break;
        payloadLen = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (basicLen === 127) {
        if (this.buffer.length < 10) break;
        const bigLen = this.buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(WS_MAX_CLIENT_FRAME_BYTES)) {
          throw new WebSocketProtocolError(
            1009,
            "WebSocket frame exceeds maximum allowed size",
          );
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      if (payloadLen > WS_MAX_CLIENT_FRAME_BYTES) {
        throw new WebSocketProtocolError(
          1009,
          "WebSocket frame exceeds maximum allowed size",
        );
      }

      // 4 bytes masking key
      if (this.buffer.length < offset + 4) break;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;

      const totalFrameLen = offset + payloadLen;
      if (this.buffer.length < totalFrameLen) {
        break; // Wait for full frame
      }

      const rawPayload = this.buffer.subarray(offset, totalFrameLen);
      const unmasked = Buffer.allocUnsafe(payloadLen);

      for (let i = 0; i < payloadLen; i++) {
        const rawByte = rawPayload[i];
        const maskByte = mask[i % 4];
        if (rawByte !== undefined && maskByte !== undefined) {
          unmasked[i] = rawByte ^ maskByte;
        }
      }

      frames.push({
        fin,
        opcode,
        payload: unmasked,
      });

      this.buffer = this.buffer.subarray(totalFrameLen);
    }

    return frames;
  }
}
