/**
 * AudioPanel.tsx — LIVE AUDIO meter (44 bars) + AI label rail.
 *
 * Ported from the legacy AudioPanel. The bars are now driven by REAL decoded
 * PCM levels (audioLevels.ts) when audio is flowing; before any audio arrives
 * they fall back to the decorative random animation (legacy WAVE_* arrays) so
 * the panel never looks dead. When the AudioContext is suspended (pre-gesture)
 * we surface the "tap to enable audio" affordance.
 *
 * Color: blue in monitoring, red in alert — RED reserved for alertMode only.
 */

import { typeColor } from '../events/theme';
import { BAR_COUNT } from '../media/audioLevels';
import type { AudioLabelRow } from '../events/incidentState';

// Decorative fallback arrays (legacy): stable random heights/timings used ONLY
// before live PCM arrives, purely for animation.
const WAVE_H = Array.from({ length: BAR_COUNT }, () => 0.1 + Math.random() * 0.9);
const WAVE_DUR = Array.from({ length: BAR_COUNT }, () => (0.3 + Math.random() * 0.6).toFixed(2));
const WAVE_DEL = Array.from({ length: BAR_COUNT }, (_, i) => (i * 0.018).toFixed(3));

interface AudioPanelProps {
  alertMode: boolean;
  audioLabels: AudioLabelRow[];
  /** 44 decoded levels in [0,1], or null before any audio. */
  levels: Float32Array | number[] | null;
  /** True if the AudioContext is unlocked (audible). */
  audioUnlocked: boolean;
  /** Tap-to-enable handler (must run from the user gesture). */
  onEnableAudio: () => void;
}

export function AudioPanel({
  alertMode,
  audioLabels,
  levels,
  audioUnlocked,
  onEnableAudio,
}: AudioPanelProps) {
  const live = !!(levels && levels.length);
  // Offer the unlock affordance once audio is flowing but the context is still
  // suspended (Safari autoplay policy).
  const needsTap = live && !audioUnlocked;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* ── waveform header ── */}
      <div
        style={{
          background: '#080e1a',
          borderRadius: '12px 12px 0 0',
          padding: '10px 12px 8px',
          borderBottom: '1px solid rgba(255,255,255,.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: alertMode ? '#ff3b5c' : '#3b82f6',
              animation: 'recBlink 1s ease-in-out infinite',
            }}
          />
          <span
            style={{ color: 'rgba(255,255,255,.5)', fontSize: 10, fontFamily: 'monospace', letterSpacing: 1 }}
          >
            LIVE AUDIO
          </span>
          <span
            style={{ marginLeft: 'auto', color: 'rgba(255,255,255,.25)', fontSize: 10, fontFamily: 'monospace' }}
          >
            {live ? 'live · 16 kHz mono' : '16 kHz · mono'}
          </span>
        </div>

        <div
          style={{ position: 'relative', display: 'flex', gap: 2, alignItems: 'flex-end', height: 56, overflow: 'hidden' }}
        >
          {WAVE_H.map((fallbackH, i) => {
            const lvl = live ? Math.max(0.05, levels?.[i] ?? 0.05) : fallbackH;
            const tone = Math.min(1, lvl);
            const bg = alertMode
              ? `rgba(255,${Math.round(59 + tone * 40)},92,${0.5 + tone * 0.5})`
              : `rgba(59,130,${Math.round(200 + tone * 55)},${0.4 + tone * 0.6})`;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  borderRadius: 2,
                  background: bg,
                  height: live ? `${Math.round(lvl * 100)}%` : '100%',
                  transformOrigin: 'bottom',
                  transition: live ? 'height 60ms linear' : 'none',
                  animation: live ? 'none' : `wvUp ${WAVE_DUR[i]}s ease-in-out infinite alternate`,
                  animationDelay: live ? '0s' : `${WAVE_DEL[i]}s`,
                }}
              />
            );
          })}

          {/* tap-to-enable audio overlay (Safari autoplay policy) */}
          {needsTap && (
            <div
              onClick={onEnableAudio}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                background: 'rgba(5,10,20,.55)',
                cursor: 'pointer',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: '#3b82f6',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                }}
              >
                🔊
              </div>
              <div style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>Tap to enable audio</div>
            </div>
          )}
        </div>
      </div>

      {/* ── label rail ── */}
      <div
        style={{
          background: '#080e1a',
          borderRadius: '0 0 12px 12px',
          overflowY: 'auto',
          scrollbarWidth: 'none',
          minHeight: 60,
        }}
      >
        {audioLabels.length === 0 ? (
          <div
            style={{
              padding: '16px 12px',
              color: 'rgba(255,255,255,.2)',
              fontSize: 12,
              textAlign: 'center',
              fontFamily: 'monospace',
            }}
          >
            No audio events yet
          </div>
        ) : (
          audioLabels.map((item, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderBottom: i < audioLabels.length - 1 ? '1px solid rgba(255,255,255,.05)' : 'none',
                background: i === 0 && alertMode ? 'rgba(255,59,92,.07)' : 'transparent',
              }}
            >
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: typeColor[item.eventType] || '#475569',
                  flexShrink: 0,
                  boxShadow: i === 0 ? `0 0 6px ${typeColor[item.eventType] || '#475569'}` : 'none',
                }}
              />
              <div
                style={{
                  color: 'rgba(255,255,255,.3)',
                  fontSize: 10,
                  fontFamily: 'monospace',
                  flexShrink: 0,
                  width: 50,
                }}
              >
                {item.time}
              </div>
              <div
                style={{
                  flex: 1,
                  color: i === 0 ? '#e2e8f0' : 'rgba(255,255,255,.6)',
                  fontSize: 12,
                  fontWeight: i === 0 ? 600 : 400,
                }}
              >
                {item.label}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: 'monospace',
                  flexShrink: 0,
                  color: item.conf >= 90 ? typeColor[item.eventType] : 'rgba(255,255,255,.3)',
                }}
              >
                {item.conf}%
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
