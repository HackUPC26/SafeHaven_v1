/**
 * RiskBanner.tsx — the AI-synthesis risk banner.
 * Ported verbatim from the legacy receiver. Color/copy by risk level:
 *   HIGH → red (reserved alert color), MED → amber, LOW → green (monitoring).
 */

import type { RiskLevel } from '../events/incidentState';

interface RiskConfig {
  bg: string;
  border: string;
  dot: string;
  dotAnim: string;
  tag: string;
  text: string;
  tagBg: string;
}

const CONFIG: Record<RiskLevel, RiskConfig> = {
  HIGH: {
    bg: 'rgba(255,59,92,.12)',
    border: 'rgba(255,59,92,.45)',
    dot: '#ff3b5c',
    dotAnim: 'pulseDot',
    tag: 'HIGH RISK',
    text: 'Critical signals detected. Recommend immediate intervention.',
    tagBg: '#ff3b5c',
  },
  MED: {
    bg: 'rgba(245,158,11,.09)',
    border: 'rgba(245,158,11,.4)',
    dot: '#f59e0b',
    dotAnim: 'pulseAmber',
    tag: 'ELEVATED',
    text: 'Raised voices or restricted movement detected. Situation escalating.',
    tagBg: '#f59e0b',
  },
  LOW: {
    bg: 'rgba(0,208,100,.06)',
    border: 'rgba(0,208,100,.3)',
    dot: '#00d064',
    dotAnim: 'pulseGreen',
    tag: 'MONITORING',
    text: 'All signals within normal range. No anomalies detected.',
    tagBg: '#00d064',
  },
};

export function RiskBanner({ level }: { level: RiskLevel }) {
  const cfg = CONFIG[level];
  return (
    <div
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 12,
        padding: '11px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        animation: level === 'HIGH' ? 'alertPulse 2s ease-in-out infinite' : 'none',
      }}
    >
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: cfg.dot,
          marginTop: 4,
          flexShrink: 0,
          animation: `${cfg.dotAnim} 1.5s ease-in-out infinite`,
        }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span
            style={{
              background: cfg.tagBg,
              color: '#000',
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: 1,
              padding: '2px 7px',
              borderRadius: 99,
              fontFamily: 'monospace',
            }}
          >
            {cfg.tag}
          </span>
          <span style={{ color: 'rgba(255,255,255,.3)', fontSize: 10, fontFamily: 'monospace' }}>
            AI synthesis
          </span>
        </div>
        <div style={{ color: 'rgba(255,255,255,.75)', fontSize: 12, lineHeight: 1.5 }}>
          {cfg.text}
        </div>
      </div>
    </div>
  );
}
