/**
 * videoDecoder.ts — WebCodecs H.264 (Annex-B) decode → <canvas> (PROTOCOL §4.1, §4.3).
 *
 * Per the contract:
 *   - Config: VideoDecoder { codec: 'avc1.42E01F', optimizeForLatency: true }
 *     with NO `description` → Annex-B IN-BAND mode. The sender ships SPS+PPS
 *     in-band on every IDR, so each keyframe is independently decodable.
 *   - Feature-detect via VideoDecoder.isConfigSupported; if WebCodecs/H.264 is
 *     absent or unsupported, fall back gracefully (the caller shows a "video
 *     unavailable" panel; audio/GPS/AI/timeline stay live).
 *   - Drop delta frames until the first KEYFRAME arrives (decoder can't start
 *     mid-GOP). A `seq` that goes BACKWARDS means the sender reconnected and
 *     its per-kind seq reset (§8) — re-arm "await keyframe".
 *   - Render each decoded VideoFrame to the canvas, then frame.close().
 *   - Staleness: track last render time; expose secondsSinceLastFrame() so the
 *     UI can show "FEED FROZEN · Ns".
 */

import type { MediaFrame } from '../transport/frame';
import type { InboundTransform } from '../transport/inboundTransform';

/** Baseline H.264, level 3.1 — matches the sender's encoder profile (§4.1). */
const H264_CODEC = 'avc1.42E01F';

export type VideoSupport = 'unknown' | 'supported' | 'unsupported';

export interface VideoDecoderControllerOptions {
  /**
   * Returns the current on-screen canvas to render into, or null if it is not
   * mounted yet. A GETTER (not a fixed element) so the controller — constructed
   * before the canvas mounts, and surviving tab switches that remount it — can
   * always draw into whatever canvas is currently live. Frames decoded while no
   * canvas is mounted are simply dropped after closing (we never queue frames).
   */
  getCanvas: () => HTMLCanvasElement | null;
  /** Inbound encryption seam — payload passes through here before decode (§9). */
  transform: InboundTransform;
  /** Called the first time a frame is successfully rendered (unfreeze the UI). */
  onFirstFrame?: () => void;
  /** Called if the decoder hard-fails or H.264 is unsupported. */
  onUnsupported?: () => void;
}

/**
 * Minimal structural typing for the WebCodecs surface we touch. We avoid hard
 * dependence on lib.dom's WebCodecs types (older TS/targets may lack them) and
 * feature-detect at runtime instead.
 */
type ConfigSupport = { supported?: boolean };
interface VideoDecoderCtor {
  new (init: { output: (frame: VideoFrameLike) => void; error: (e: unknown) => void }): VideoDecoderLike;
  isConfigSupported?: (config: Record<string, unknown>) => Promise<ConfigSupport>;
}
interface VideoDecoderLike {
  configure: (config: Record<string, unknown>) => void;
  decode: (chunk: unknown) => void;
  readonly state: string;
  close: () => void;
}
interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close: () => void;
}

export class VideoDecoderController {
  private readonly getCanvas: () => HTMLCanvasElement | null;
  private readonly transform: InboundTransform;
  private readonly onFirstFrame?: () => void;
  private readonly onUnsupported?: () => void;

  private decoder: VideoDecoderLike | null = null;
  private support: VideoSupport = 'unknown';
  /** Until the first keyframe arrives we drop everything (can't start mid-GOP). */
  private awaitingKeyframe = true;
  private lastSeq = -1;
  private lastFrameAtMs = 0;
  private gotFirstFrame = false;

  constructor(opts: VideoDecoderControllerOptions) {
    this.getCanvas = opts.getCanvas;
    this.transform = opts.transform;
    this.onFirstFrame = opts.onFirstFrame;
    this.onUnsupported = opts.onUnsupported;
  }

  /** Whether WebCodecs H.264 decode is usable in this browser. */
  getSupport(): VideoSupport {
    return this.support;
  }

  /** Seconds since the last successfully-rendered frame (0 if none yet). */
  secondsSinceLastFrame(): number {
    if (!this.lastFrameAtMs) return 0;
    return Math.max(0, Math.floor((performance.now() - this.lastFrameAtMs) / 1000));
  }

  /** True once at least one frame has been rendered. */
  hasRenderedFrame(): boolean {
    return this.gotFirstFrame;
  }

  /**
   * Probe WebCodecs + H.264 support. Safe to call once on mount. Resolves the
   * support state; on 'unsupported' the caller should render the fallback.
   */
  async probe(): Promise<VideoSupport> {
    const Ctor = (globalThis as unknown as { VideoDecoder?: VideoDecoderCtor }).VideoDecoder;
    if (typeof Ctor !== 'function') {
      this.support = 'unsupported';
      this.onUnsupported?.();
      return this.support;
    }
    try {
      if (typeof Ctor.isConfigSupported === 'function') {
        const res = await Ctor.isConfigSupported({
          codec: H264_CODEC,
          optimizeForLatency: true,
        });
        this.support = res && res.supported ? 'supported' : 'unsupported';
      } else {
        // No isConfigSupported — assume usable and let decode() error surface.
        this.support = 'supported';
      }
    } catch {
      this.support = 'unsupported';
    }
    if (this.support === 'unsupported') this.onUnsupported?.();
    return this.support;
  }

  /**
   * Feed one VIDEO_H264 binary frame. No-op when unsupported. The payload is
   * passed through the InboundTransform (decrypt seam) before becoming an
   * EncodedVideoChunk.
   */
  pushVideo(frame: MediaFrame): void {
    if (this.support === 'unsupported') return;

    // seq went backwards => sender reconnected, per-kind seq reset (§8). Treat
    // as a stream restart: re-arm await-keyframe and rebuild the decoder so we
    // don't feed deltas against a stale reference frame.
    if (frame.seq < this.lastSeq) {
      this.awaitingKeyframe = true;
      this.teardownDecoder();
    }
    this.lastSeq = frame.seq;

    if (this.awaitingKeyframe) {
      if (!frame.keyframe) return; // can't start on a delta — drop.
      this.awaitingKeyframe = false;
    }

    if (!this.decoder) {
      if (!this.createDecoder()) return;
    }
    const decoder = this.decoder;
    if (!decoder || decoder.state === 'closed') return;

    // ── Encryption seam: payload decrypt happens in transform.openMedia (§9). ──
    const data = this.transform.openMedia(frame.payload);

    try {
      const ChunkCtor = (globalThis as unknown as {
        EncodedVideoChunk?: new (init: {
          type: 'key' | 'delta';
          timestamp: number;
          // Typed as the concrete view we hand it; the platform accepts any
          // BufferSource. Avoids the lib's strict ArrayBuffer-vs-SharedArray
          // BufferSource narrowing on Uint8Array<ArrayBufferLike>.
          data: Uint8Array;
        }) => unknown;
      }).EncodedVideoChunk;
      if (!ChunkCtor) return;
      const chunk = new ChunkCtor({
        type: frame.keyframe ? 'key' : 'delta',
        timestamp: frame.ptsMicros, // microseconds, capture clock (§3).
        data,
      });
      decoder.decode(chunk);
    } catch {
      // A decode throw usually means a corrupt GOP; re-arm and wait for the
      // next IDR rather than killing the feed.
      this.awaitingKeyframe = true;
    }
  }

  /** Tear everything down (component unmount / token switch). */
  dispose(): void {
    this.teardownDecoder();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private createDecoder(): boolean {
    const Ctor = (globalThis as unknown as { VideoDecoder?: VideoDecoderCtor }).VideoDecoder;
    if (typeof Ctor !== 'function') {
      this.support = 'unsupported';
      this.onUnsupported?.();
      return false;
    }
    try {
      const decoder = new Ctor({
        output: (vf) => this.renderFrame(vf),
        error: () => {
          // Decoder errored — re-arm await-keyframe and rebuild on next IDR.
          this.awaitingKeyframe = true;
          this.teardownDecoder();
        },
      });
      // NO `description` => Annex-B in-band mode (§4.1). SPS/PPS arrive with
      // each IDR in the bitstream itself.
      decoder.configure({ codec: H264_CODEC, optimizeForLatency: true });
      this.decoder = decoder;
      this.support = 'supported';
      return true;
    } catch {
      this.support = 'unsupported';
      this.onUnsupported?.();
      return false;
    }
  }

  private renderFrame(vf: VideoFrameLike): void {
    try {
      const canvas = this.getCanvas();
      const ctx = canvas?.getContext('2d') ?? null;
      if (canvas && ctx) {
        // Size the canvas to the source once it's known, then draw.
        if (canvas.width !== vf.displayWidth || canvas.height !== vf.displayHeight) {
          canvas.width = vf.displayWidth;
          canvas.height = vf.displayHeight;
        }
        // VideoFrame is a valid CanvasImageSource in WebCodecs-capable browsers.
        ctx.drawImage(vf as unknown as CanvasImageSource, 0, 0);
      }
    } catch {
      /* swallow draw errors — never kill the feed on a single frame */
    } finally {
      // ALWAYS close the frame to release the GPU/codec buffer (§4.1).
      vf.close();
    }
    this.lastFrameAtMs = performance.now();
    if (!this.gotFirstFrame) {
      this.gotFirstFrame = true;
      this.onFirstFrame?.();
    }
  }

  private teardownDecoder(): void {
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') this.decoder.close();
      } catch {
        /* ignore */
      }
      this.decoder = null;
    }
  }
}
