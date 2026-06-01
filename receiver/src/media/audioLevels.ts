/**
 * audioLevels.ts — 44-bar live audio meter from decoded PCM (PROTOCOL §4.2).
 *
 * The legacy receiver tapped a MediaStream analyser node. With raw PCM over the
 * socket there is no MediaStream, so we compute the bar heights directly from
 * the decoded Float32 samples that audioPlayer emits.
 *
 * Approach: maintain a small ring of the most recent samples; each animation
 * tick, slice it into 44 contiguous windows and take each window's RMS as the
 * bar height. RMS (not peak) gives a smooth, musical-looking meter that matches
 * the legacy frequency-bar feel without an FFT. A light exponential smoothing
 * per bar avoids flicker, mirroring the analyser's smoothingTimeConstant.
 */

export const BAR_COUNT = 44;

/**
 * ~3 chunks of 20 ms (960 samples at 16 kHz) is plenty of history for 44 bars
 * while staying responsive. Sized generously and overwritten ring-style.
 */
const RING_SAMPLES = 1024;

export class AudioLevelMeter {
  private readonly ring = new Float32Array(RING_SAMPLES);
  private writePos = 0;
  /** Smoothed per-bar heights in [0,1]. */
  private readonly smoothed = new Float32Array(BAR_COUNT);
  private hasData = false;

  /** Feed a freshly decoded PCM chunk (Float32, [-1,1)). */
  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.hasData = true;
    // Copy the tail of the chunk into the ring (most-recent-wins). For chunks
    // larger than the ring we keep only the final RING_SAMPLES.
    const n = samples.length;
    const start = n > RING_SAMPLES ? n - RING_SAMPLES : 0;
    for (let i = start; i < n; i++) {
      this.ring[this.writePos] = samples[i] as number;
      this.writePos = (this.writePos + 1) % RING_SAMPLES;
    }
  }

  /** True once any audio has been received (drives "live" vs decorative mode). */
  isLive(): boolean {
    return this.hasData;
  }

  /**
   * Compute the current 44 bar heights in [0,1]. Reads the ring in
   * chronological order (oldest→newest) so the bars sweep naturally.
   */
  levels(): Float32Array {
    const windowSize = Math.max(1, Math.floor(RING_SAMPLES / BAR_COUNT));
    for (let bar = 0; bar < BAR_COUNT; bar++) {
      let sumSq = 0;
      for (let j = 0; j < windowSize; j++) {
        // Read oldest-first starting at writePos (the oldest sample).
        const idx = (this.writePos + bar * windowSize + j) % RING_SAMPLES;
        const s = this.ring[idx] as number;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / windowSize);
      // Perceptual lift: RMS of speech is small; a sqrt-ish curve makes the
      // meter lively without clipping. Clamp to [0,1].
      const target = Math.min(1, Math.sqrt(rms) * 1.6);
      // Exponential smoothing (attack faster than release feels natural).
      const prev = this.smoothed[bar] as number;
      const alpha = target > prev ? 0.6 : 0.25;
      this.smoothed[bar] = prev + (target - prev) * alpha;
    }
    return this.smoothed;
  }

  /** Reset history (token switch / session reset). */
  reset(): void {
    this.ring.fill(0);
    this.smoothed.fill(0);
    this.writePos = 0;
    this.hasData = false;
  }
}
