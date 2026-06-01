/**
 * audioPlayer.ts — Web Audio playback of raw PCM (PROTOCOL §4.2).
 *
 * Wire audio is Int16 LE, mono, 16 kHz, ~20 ms chunks (320 samples / 640 bytes).
 * For each AUDIO_PCM frame we:
 *   1. Pass the payload through the InboundTransform (decrypt seam, §9).
 *   2. Convert Int16 → Float32 (sample / 32768).
 *   3. Wrap in a mono AudioBuffer and SCHEDULE it on a running playout clock so
 *      consecutive chunks play back-to-back (gapless), absorbing small jitter.
 *
 * Safari/iOS ship the AudioContext SUSPENDED until a user gesture, so we keep
 * the legacy "tap to enable audio" affordance: resume() must be driven by a
 * real click/touch. Until resumed, decoded levels still flow to the meter
 * (audioLevels.ts) so the bars animate even before audio is unlocked.
 */

import { type MediaFrame } from '../transport/frame';
import type { InboundTransform } from '../transport/inboundTransform';

/** Wire PCM sample rate (§4.2). */
const PCM_SAMPLE_RATE = 16000;

/**
 * How far ahead of the context clock we keep scheduling. A small lead absorbs
 * network jitter without adding perceptible latency. If the playhead falls
 * behind real time (underrun), we re-anchor to "now + lead".
 */
const SCHEDULE_LEAD_S = 0.08;
/** If we've drifted more than this behind, hard-resync to avoid pile-up. */
const MAX_DRIFT_S = 0.5;

export type AudioCallback = (samples: Float32Array) => void;

export class AudioPlayer {
  private readonly transform: InboundTransform;
  private ctx: AudioContext | null = null;
  /** Next start time (in AudioContext time) for the following chunk. */
  private nextStartTime = 0;
  /** Listeners that receive each decoded chunk's Float32 samples (for meters). */
  private readonly sampleListeners = new Set<AudioCallback>();
  /** True once the context is running (post-gesture). */
  private unlocked = false;

  constructor(transform: InboundTransform) {
    this.transform = transform;
  }

  /** Whether the AudioContext is running (audio is audible). */
  isUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * Lazily create the AudioContext. Created suspended on Safari; resume() must
   * be called from a user gesture. Returns the context (or null if Web Audio
   * is unavailable).
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    this.unlocked = this.ctx.state === 'running';
    return this.ctx;
  }

  /**
   * Resume the AudioContext from a user gesture (the "tap to enable audio"
   * handler). Safe to call repeatedly.
   */
  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      await ctx.resume();
      this.unlocked = ctx.state === 'running';
    } catch {
      /* gesture may not have propagated; caller can retry */
    }
  }

  /** Subscribe to decoded PCM samples (used by the 44-bar meter). */
  onSamples(cb: AudioCallback): () => void {
    this.sampleListeners.add(cb);
    return () => this.sampleListeners.delete(cb);
  }

  /**
   * Feed one AUDIO_PCM binary frame. Decrypts (seam), converts Int16→Float32,
   * notifies meter listeners, and — if unlocked — schedules gapless playback.
   */
  pushAudio(frame: MediaFrame): void {
    // ── Encryption seam: payload decrypt happens in transform.openMedia (§9). ──
    const bytes = this.transform.openMedia(frame.payload);

    const samples = int16ToFloat32(bytes);
    if (samples.length === 0) return;

    // Always feed the meter, even before the context is unlocked.
    for (const listener of this.sampleListeners) listener(samples);

    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') {
      // Not unlocked yet — meter still moves; audio resumes once user taps.
      this.unlocked = false;
      return;
    }
    this.unlocked = true;

    this.schedule(ctx, samples);
  }

  /** Schedule a chunk on the running playout clock for gapless playback. */
  private schedule(ctx: AudioContext, samples: Float32Array): void {
    let buffer: AudioBuffer;
    try {
      buffer = ctx.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);
    } catch {
      return; // e.g. invalid length — drop this chunk.
    }

    const now = ctx.currentTime;
    // Re-anchor if we've never scheduled, fell behind, or drifted too far ahead.
    if (
      this.nextStartTime < now + 0.001 ||
      this.nextStartTime - now > MAX_DRIFT_S
    ) {
      this.nextStartTime = now + SCHEDULE_LEAD_S;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    try {
      src.start(this.nextStartTime);
    } catch {
      return;
    }
    this.nextStartTime += buffer.duration; // advance the playout clock.
  }

  /** Release the AudioContext (unmount / token switch). */
  dispose(): void {
    this.sampleListeners.clear();
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    this.nextStartTime = 0;
    this.unlocked = false;
  }
}

/**
 * Convert a little-endian Int16 PCM byte buffer to Float32 in [-1, 1).
 * Handles odd byte alignment of the Uint8Array view (offset may be non-zero
 * because frame payloads are zero-copy views into the WS buffer).
 */
export function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(sampleCount);
  // DataView reads at arbitrary alignment; we read LE 16-bit signed.
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, /* littleEndian */ true) / 32768;
  }
  return out;
}
