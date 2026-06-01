/**
 * IncidentLog.tsx — the incident timeline. Ported verbatim from legacy.
 * Newest-first; first two rows emphasized; red rows get a subtle highlight.
 */

import { DOT_COLOR } from '../events/theme';
import { tsToTime, type LogRow } from '../events/incidentState';

export function IncidentLog({ incidentLog }: { incidentLog: LogRow[] }) {
  if (incidentLog.length === 0) {
    return (
      <div
        style={{
          padding: '24px',
          color: 'rgba(255,255,255,.2)',
          fontSize: 12,
          textAlign: 'center',
          fontFamily: 'monospace',
        }}
      >
        No events yet
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {incidentLog.map((item, i) => (
        <div
          key={`${item.ts}-${i}`}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '11px 14px',
            borderBottom: i < incidentLog.length - 1 ? '1px solid rgba(255,255,255,.05)' : 'none',
            background: i < 2 && item.dot === 'red' ? 'rgba(255,59,92,.06)' : 'transparent',
          }}
        >
          <div style={{ paddingTop: 4 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: DOT_COLOR[item.dot] || '#475569',
                flexShrink: 0,
                boxShadow: i === 0 ? `0 0 8px ${DOT_COLOR[item.dot] || '#475569'}` : 'none',
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span
              style={{
                color: i < 2 ? '#e2e8f0' : 'rgba(255,255,255,.65)',
                fontSize: 13,
                fontWeight: i < 2 ? 600 : 400,
              }}
            >
              {item.label}
            </span>
            {item.sub && (
              <div style={{ color: 'rgba(255,255,255,.35)', fontSize: 11, marginTop: 2 }}>
                {item.sub}
              </div>
            )}
          </div>
          <div
            style={{
              color: 'rgba(255,255,255,.25)',
              fontSize: 10,
              fontFamily: 'monospace',
              flexShrink: 0,
              paddingTop: 2,
            }}
          >
            {tsToTime(item.ts)}
          </div>
        </div>
      ))}
    </div>
  );
}
