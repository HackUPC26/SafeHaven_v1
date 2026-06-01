/**
 * Tabs.tsx — Live / Map / Log segmented control. Ported verbatim from legacy.
 */

export type TabId = 'live' | 'map' | 'log';

const TABS: ReadonlyArray<[TabId, string]> = [
  ['live', 'Live'],
  ['map', 'Map'],
  ['log', 'Log'],
];

export function Tabs({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 3,
        background: 'rgba(255,255,255,.05)',
        borderRadius: 12,
        padding: 3,
      }}
    >
      {TABS.map(([id, label]) => (
        <div
          key={id}
          onClick={() => onChange(id)}
          style={{
            flex: 1,
            padding: '8px',
            textAlign: 'center',
            borderRadius: 9,
            cursor: 'pointer',
            background: tab === id ? 'rgba(255,255,255,.15)' : 'transparent',
            color: tab === id ? '#fff' : 'rgba(255,255,255,.4)',
            fontSize: 13,
            fontWeight: tab === id ? 600 : 400,
            transition: 'all .2s',
          }}
        >
          {label}
        </div>
      ))}
    </div>
  );
}
