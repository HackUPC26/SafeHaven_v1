/**
 * Footer.tsx — fixed action footer.
 *
 * Primary action: Call Police with location. Per PROTOCOL/contract the href is
 *   tel:112?body=Emergency+at+<lat>,<lng>
 * and this is the ONLY place RED (#ff3b5c) is used outside HIGH-risk styling:
 * the button goes red+glowing in alertMode, otherwise a calm protective blue.
 *
 * (The legacy "Save Evidence Package" tile and Simulate/Dismiss dev buttons are
 * intentionally dropped — v1 has no client-side evidence store, and the real
 * relay/sender drive the session, so a fake SOS simulator would be misleading.)
 */

import type { GpsFix } from '../events/incidentState';

export function Footer({ gps, alertMode }: { gps: GpsFix | null; alertMode: boolean }) {
  // tel:112 with the body carrying the coordinates when we have a fix.
  const callHref = gps
    ? `tel:112?body=${encodeURIComponent(`Emergency at ${gps.lat},${gps.lng}`)}`
    : 'tel:112';
  const coords = gps ? `${gps.lat.toFixed(4)}° N · ${gps.lng.toFixed(4)}° E` : null;

  return (
    <div
      style={{
        flexShrink: 0,
        background: '#060b14',
        borderTop: '1px solid rgba(255,255,255,.07)',
        padding: '12px 14px',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom))',
      }}
    >
      <a href={callHref} style={{ display: 'block', textDecoration: 'none' }}>
        <div
          style={{
            background: alertMode
              ? 'linear-gradient(135deg,#ff3b5c,#c0002e)' // RED reserved for alert.
              : 'linear-gradient(135deg,#1d3a5f,#0f2240)',
            borderRadius: 14,
            padding: '15px',
            textAlign: 'center',
            cursor: 'pointer',
            boxShadow: alertMode ? '0 4px 20px rgba(255,59,92,.45)' : 'none',
            border: alertMode ? '1px solid rgba(255,100,120,.3)' : '1px solid rgba(59,130,246,.2)',
          }}
        >
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>
            {alertMode ? '🚨 Call Police with Location' : '📞 Call Police with Location'}
          </div>
          <div
            style={{ color: 'rgba(255,255,255,.5)', fontSize: 11, marginTop: 3, fontFamily: 'monospace' }}
          >
            {coords || 'Awaiting GPS fix'}
          </div>
        </div>
      </a>

      {/* iOS-style home indicator (legacy parity). */}
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
        <div style={{ width: 139, height: 5, borderRadius: 100, background: 'rgba(255,255,255,.2)' }} />
      </div>
    </div>
  );
}
