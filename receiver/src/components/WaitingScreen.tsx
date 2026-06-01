/**
 * WaitingScreen.tsx — shown after connecting but before any session signal.
 * Ported verbatim from the legacy WaitingScreen.
 */

export function WaitingScreen({ statusText }: { statusText?: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: '3px solid rgba(59,130,246,.3)',
          borderTop: '3px solid #3b82f6',
          animation: 'spin 1s linear infinite',
        }}
      />
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: 'rgba(255,255,255,.7)', fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          {statusText ?? 'Waiting for connection'}
        </div>
        <div style={{ color: 'rgba(255,255,255,.3)', fontSize: 13 }}>
          Open the shared SafeHaven link on a sender device
        </div>
      </div>
    </div>
  );
}
