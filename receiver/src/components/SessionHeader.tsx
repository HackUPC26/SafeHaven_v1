/**
 * SessionHeader.tsx — top header: avatar, person name, tier pill, elapsed timer,
 * connection dot. Ported from the legacy App header block.
 *
 * Tier pill color escalates: idle (grey) → Tier ≥1 (amber) → Tier ≥3 (red).
 * The connection dot reflects the live socket status (green when connected).
 */

interface SessionHeaderProps {
  personName: string | null;
  tier: number;
  /** True while the socket is OPEN. */
  connected: boolean;
  /** True while a session is active (shows the elapsed timer). */
  hasSession: boolean;
  /** Elapsed seconds since session start. */
  elapsed: number;
  /** Optional status line override (e.g. "Reconnecting…"). */
  statusText?: string;
}

export function SessionHeader({
  personName,
  tier,
  connected,
  hasSession,
  elapsed,
  statusText,
}: SessionHeaderProps) {
  const tierLabel = tier > 0 ? `TIER ${tier}` : 'IDLE';
  const tierColor = tier >= 3 ? '#ff8099' : tier >= 1 ? '#fcd34d' : 'rgba(255,255,255,.3)';
  const tierBg =
    tier >= 3 ? 'rgba(255,59,92,.2)' : tier >= 1 ? 'rgba(245,158,11,.2)' : 'rgba(255,255,255,.08)';
  const tierBorder =
    tier >= 3 ? 'rgba(255,59,92,.4)' : tier >= 1 ? 'rgba(245,158,11,.4)' : 'rgba(255,255,255,.1)';

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  const connLabel = statusText ?? (connected ? 'Connected' : 'Disconnected');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 2px 10px' }}>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          flexShrink: 0,
          background: personName ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : 'rgba(255,255,255,.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontSize: 18,
          fontWeight: 700,
        }}
      >
        {personName ? personName[0]?.toUpperCase() : '?'}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              color: personName ? '#fff' : 'rgba(255,255,255,.3)',
              fontSize: 16,
              fontWeight: 700,
            }}
          >
            {personName || 'No session'}
          </span>
          <span
            style={{
              background: tierBg,
              border: `1px solid ${tierBorder}`,
              color: tierColor,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.5,
              padding: '2px 7px',
              borderRadius: 99,
              fontFamily: 'monospace',
            }}
          >
            {tierLabel}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          {hasSession && (
            <span style={{ color: 'rgba(255,255,255,.35)', fontSize: 11, fontFamily: 'monospace' }}>
              {mm}:{ss}
            </span>
          )}
          {hasSession && <span style={{ color: 'rgba(255,255,255,.2)', fontSize: 11 }}>·</span>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: connected ? '#00d064' : '#475569',
              }}
            />
            <span
              style={{
                color: connected ? 'rgba(0,208,100,.7)' : 'rgba(255,255,255,.3)',
                fontSize: 11,
              }}
            >
              {connLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
