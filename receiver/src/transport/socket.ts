/**
 * socket.ts — receiver WebSocket lifecycle (PROTOCOL §1.3, §6, §8, §10).
 *
 * One WebSocket carries everything for this receiver:
 *   - WS TEXT  frames = UTF-8 JSON: control ({type:"presence"|"hello"}) and
 *                       product events ({type:"event", payload:{...}}).
 *   - WS BINARY frames = 16-byte LE header + opaque media payload (frame.ts).
 *
 * Responsibilities:
 *   - Connect to  <ws|wss>://HOST/ws?role=receiver&token=<enc>&v=1  (§1.3).
 *     Same-origin path "/ws" so dev (Vite proxy) and prod (relay serves bundle)
 *     both work without a hardcoded host.
 *   - binaryType = 'arraybuffer' so binary frames arrive as ArrayBuffer.
 *   - Demux text (JSON.parse) vs binary (parseMediaFrame); route to callbacks.
 *   - Auto-reconnect with backoff: start 2000ms, ×1.5 per close, cap 30000ms,
 *     reset to 2000 on open (§8).
 *   - Act on close codes (§10): 4000/4002/4003 are TERMINAL (stop reconnecting,
 *     surface a message). 4001 (missing token) is also terminal here — we never
 *     connect without a token. Any other close (network/1006/1001/...) retries.
 *   - Idempotent start keyed by token (§8): re-entry with the same token does
 *     NOT open a second socket.
 *
 * The receiver only ever SENDS the optional {type:"hello",v:1} (§6.1); it never
 * sends media or addresses other receivers.
 */

import { MediaKind, parseMediaFrame, type MediaFrame } from './frame';

export const PROTOCOL_VERSION = 1;

/** WebSocket close codes defined by the protocol (§10). */
export const CLOSE = {
  INVALID_ROLE: 4000,
  MISSING_TOKEN: 4001,
  SENDER_ALREADY_CONNECTED: 4002,
  VERSION_MISMATCH: 4003,
} as const;

/** Reconnect backoff parameters (§8 / §11). */
const BACKOFF_START_MS = 2000;
const BACKOFF_FACTOR = 1.5;
const BACKOFF_CAP_MS = 30000;

/** A control or product-event text frame, as delivered by the relay. */
export type TextFrame =
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'presence'; event: 'receiver_joined' | 'receiver_left'; receivers: number }
  | { type: 'hello'; v: number }
  | { type: string; [k: string]: unknown };

/** High-level connection status surfaced to the UI. */
export type ConnectionStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'reconnecting'; delayMs: number }
  /** Terminal — won't retry. `message` is user-facing. */
  | { state: 'terminated'; code: number; message: string };

export interface SocketCallbacks {
  /** A product event ({type:"event"}). `payload` is the inner event object. */
  onEvent: (payload: Record<string, unknown>) => void;
  /** A decoded binary media frame (video AU or PCM chunk). */
  onMedia: (frame: MediaFrame) => void;
  /** Connection status changes (drive the header dot + overlays). */
  onStatus: (status: ConnectionStatus) => void;
}

/**
 * Human-readable, non-alarming messages for terminal close codes. The receiver
 * is a safety tool seen by a worried contact — copy stays calm and actionable.
 */
function terminalMessage(code: number): string | null {
  switch (code) {
    case CLOSE.INVALID_ROLE:
      return 'Connection rejected (invalid role). Please reopen the SafeHaven link.';
    case CLOSE.MISSING_TOKEN:
      return 'This link is missing its session token. Please reopen the SafeHaven link.';
    case CLOSE.SENDER_ALREADY_CONNECTED:
      // 4002 is sender-collision; a receiver should not normally see it, but be safe.
      return 'Another device is already streaming on this session.';
    case CLOSE.VERSION_MISMATCH:
      return 'This dashboard is out of date for the current session. Please refresh.';
    default:
      return null; // not terminal — caller will retry.
  }
}

export class ReceiverSocket {
  private readonly token: string;
  private readonly cb: SocketCallbacks;

  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the consumer calls close(); prevents any further reconnect. */
  private stopped = false;
  /** True once a terminal close code was seen; prevents reconnect. */
  private terminated = false;

  constructor(token: string, cb: SocketCallbacks) {
    this.token = token;
    this.cb = cb;
  }

  /** The token this socket is keyed on (used for idempotent-start checks). */
  getToken(): string {
    return this.token;
  }

  /**
   * Open the socket. Idempotent: if a socket for this token is already
   * connecting/open (and not terminated), this is a no-op (§8 idempotent start).
   */
  start(): void {
    if (this.stopped || this.terminated) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return; // already live for this token — do not open a second socket.
    }
    this.connect();
  }

  /** Permanently stop this socket and cancel any pending reconnect. */
  close(): void {
    this.stopped = true;
    this.clearReconnect();
    if (this.ws) {
      // Remove handlers first so our own onclose doesn't schedule a reconnect.
      this.detach(this.ws);
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private connect(): void {
    this.clearReconnect();
    this.cb.onStatus({ state: 'connecting' });

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Same-origin "/ws" path (dev: Vite proxies to ws://localhost:8080).
    const url = `${scheme}://${window.location.host}/ws?role=receiver&token=${encodeURIComponent(
      this.token,
    )}&v=${PROTOCOL_VERSION}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Construction itself failed (bad URL/host) — retry with backoff.
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer'; // §2 — binary frames as ArrayBuffer.
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = BACKOFF_START_MS; // reset backoff on a successful open.
      // Optional {type:"hello"} announce (§6.1). role+token are already in the
      // query string; hello carries the version and is reserved for future
      // negotiation. Harmless if the relay ignores it.
      try {
        ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION }));
      } catch {
        /* ignore */
      }
      this.cb.onStatus({ state: 'open' });
    };

    ws.onmessage = (e: MessageEvent) => this.handleMessage(e.data);

    ws.onerror = () => {
      // onerror is followed by onclose; let onclose drive reconnect. We close
      // proactively so a half-open socket doesn't linger.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    ws.onclose = (e: CloseEvent) => {
      // Only react to the socket we currently own.
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;

      const msg = terminalMessage(e.code);
      if (msg) {
        // Terminal close code — stop reconnecting and surface the reason.
        this.terminated = true;
        this.cb.onStatus({ state: 'terminated', code: e.code, message: msg });
        return;
      }
      // Network / transient close (1006, 1001, server restart, …) — retry.
      this.scheduleReconnect();
    };
  }

  /** Demux a single inbound frame: ArrayBuffer => media, string => JSON. */
  private handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const frame = parseMediaFrame(data);
      if (!frame) return; // malformed/unknown version — drop defensively.
      // Only the two known kinds are routed; anything else is ignored.
      if (frame.kind === MediaKind.Video || frame.kind === MediaKind.Audio) {
        this.cb.onMedia(frame);
      }
      return;
    }

    if (typeof data === 'string') {
      let msg: TextFrame;
      try {
        msg = JSON.parse(data) as TextFrame;
      } catch {
        return; // not JSON — ignore.
      }
      if (msg && msg.type === 'event' && 'payload' in msg && msg.payload) {
        this.cb.onEvent(msg.payload as Record<string, unknown>);
      }
      // {type:"presence"} is relay->SENDER only (§6.2); a receiver should never
      // see it, and {type:"hello"} is our own. Both are safely ignored here.
      return;
    }

    // Some environments may deliver a Blob; we set binaryType='arraybuffer' so
    // this should not happen, but guard anyway.
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then((buf) => this.handleMessage(buf)).catch(() => {});
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.terminated) return;
    this.clearReconnect();
    const delay = this.backoffMs;
    this.cb.onStatus({ state: 'reconnecting', delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      // Grow backoff for the NEXT attempt (capped); a successful open resets it.
      this.backoffMs = Math.min(this.backoffMs * BACKOFF_FACTOR, BACKOFF_CAP_MS);
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }
}
