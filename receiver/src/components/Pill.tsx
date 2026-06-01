/**
 * Pill.tsx — small stat tile (accuracy / speed / heading / altitude / signal).
 * Ported verbatim from legacy.
 */

export function Pill({
  label,
  value,
  color = '#3b82f6',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: 'rgba(255,255,255,.04)',
        border: '0.5px solid rgba(255,255,255,.07)',
        borderRadius: 12,
        padding: '10px 12px',
      }}
    >
      <div style={{ color: 'rgba(255,255,255,.35)', fontSize: 10, letterSpacing: 0.5, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
