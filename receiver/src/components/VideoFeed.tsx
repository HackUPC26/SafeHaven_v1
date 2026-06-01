/**
 * VideoFeed.tsx — the live video panel, now a <canvas> fed by WebCodecs.
 *
 * The App owns the VideoDecoderController (videoDecoder.ts); it decodes H.264
 * Annex-B frames and draws each VideoFrame into the <canvas> exposed here via
 * `canvasRef`. This component is purely presentational over that canvas plus
 * the overlay states:
 *
 *   - hasVideo=false, tier<2  → "AWAITING VIDEO / Available at Tier 2+"
 *     (video streaming begins at Tier ≥ 2 per PROTOCOL §4.1 / decision table).
 *   - hasVideo=false, tier>=2 → "AWAITING VIDEO" (gate passed, frames pending).
 *   - frozen (stale)          → "FEED FROZEN · Ns since last frame".
 *   - unsupported             → "Video unavailable in this browser" (§4.3).
 *   - live                    → canvas visible, LIVE pill, scanline, brackets.
 *
 * Corner brackets stay cyan when idle and switch to red in alertMode.
 */

import { useEffect, useRef } from 'react';

interface VideoFeedProps {
  alertMode: boolean;
  /** WebCodecs H.264 support state. 'unsupported' → graceful fallback (§4.3). */
  videoSupported: boolean;
  /** True once at least one frame has rendered AND it isn't stale. */
  live: boolean;
  /** True if frames have stopped (staleness) — shows FEED FROZEN. */
  frozen: boolean;
  /** Seconds since the last rendered frame (drives the frozen subtitle). */
  staleSecs: number;
  /** True once any frame has ever rendered (distinguishes "awaiting" vs "frozen"). */
  everRendered: boolean;
  /** Current tier — gates the "Available at Tier 2+" hint. */
  tier: number;
  /** Receives the <canvas> element so the App can hand it to the decoder. */
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
}

export function VideoFeed({
  alertMode,
  videoSupported,
  live,
  frozen,
  staleSecs,
  everRendered,
  tier,
  onCanvas,
}: VideoFeedProps) {
  const ac = alertMode ? '#ff3b5c' : '#22d3ee'; // cyan idle, red alert.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Hand the canvas up to the App exactly once it mounts / on unmount.
  useEffect(() => {
    onCanvas(canvasRef.current);
    return () => onCanvas(null);
  }, [onCanvas]);

  return (
    <div
      style={{
        position: 'relative',
        height: 280,
        background: '#000',
        overflow: 'hidden',
        borderRadius: 12,
        flexShrink: 0,
      }}
    >
      {/* The decode target. Always mounted so the decoder has a stable surface;
          hidden behind overlays until the first frame lands. objectFit:cover
          via CSS since the canvas internal size tracks the source dimensions. */}
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          background: '#000',
        }}
      />

      {/* ── Unsupported (WebCodecs/H.264 absent) — graceful fallback (§4.3) ── */}
      {!videoSupported && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(5,10,18,.85)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: 16,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 22 }}>📵</div>
          <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>
            Video unavailable in this browser
          </div>
          <div style={{ color: 'rgba(255,255,255,.3)', fontSize: 10, fontFamily: 'monospace' }}>
            Audio, location & alerts remain live
          </div>
        </div>
      )}

      {/* ── LIVE / FROZEN / AWAITING overlays (only when supported) ── */}
      {videoSupported && live && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(5,10,20,.55)',
              padding: '3px 8px',
              borderRadius: 6,
            }}
          >
            <div
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#ff3b5c',
                animation: 'recBlink 1s ease-in-out infinite',
              }}
            />
            <span
              style={{ color: '#fff', fontSize: 10, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 1 }}
            >
              LIVE
            </span>
          </div>
          {/* faint scanline only while truly live */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: 40,
              background: 'linear-gradient(transparent,rgba(255,255,255,.025),transparent)',
              animation: 'scanline 3s linear infinite',
              pointerEvents: 'none',
            }}
          />
        </>
      )}

      {videoSupported && !live && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(5,10,18,.7)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          {frozen && everRendered ? (
            <>
              <div
                style={{ color: '#f59e0b', fontSize: 12, fontWeight: 700, letterSpacing: 1, fontFamily: 'monospace' }}
              >
                FEED FROZEN
              </div>
              <div style={{ color: 'rgba(255,255,255,.45)', fontSize: 10, fontFamily: 'monospace' }}>
                {staleSecs}s since last frame
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  color: 'rgba(255,255,255,.3)',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 1,
                  fontFamily: 'monospace',
                }}
              >
                AWAITING VIDEO
              </div>
              <div style={{ color: 'rgba(255,255,255,.2)', fontSize: 10, fontFamily: 'monospace' }}>
                {tier >= 2 ? 'Decoding stream…' : 'Available at Tier 2+'}
              </div>
            </>
          )}
        </div>
      )}

      {/* corner brackets (cyan idle / red alert) — always visible */}
      {([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const).map(([cx, cy], i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            [cx ? 'right' : 'left']: 8,
            [cy ? 'bottom' : 'top']: 8,
            width: 16,
            height: 16,
            borderTop: cy ? 'none' : `1.5px solid ${ac}`,
            borderBottom: cy ? `1.5px solid ${ac}` : 'none',
            borderLeft: cx ? 'none' : `1.5px solid ${ac}`,
            borderRight: cx ? `1.5px solid ${ac}` : 'none',
            opacity: 0.7,
          }}
        />
      ))}
    </div>
  );
}
