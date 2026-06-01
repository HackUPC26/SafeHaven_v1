/**
 * TokenEntry.tsx — overlay shown when there is no token in the URL fragment.
 *
 * Ported from the legacy #token-overlay. The user pastes the pairing string
 * from the sender's hidden Settings. Per PROTOCOL §1.2 the pairing is
 * "<token>:<key>"; this overlay accepts the FULL pairing string and lets the
 * App split it (pairing.ts) — pasting just a token (legacy links) also works.
 */

import { useEffect, useRef, useState } from 'react';

export function TokenEntry({ onSubmit }: { onSubmit: (pairing: string) => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus shortly after mount (matches legacy setTimeout(...,50)).
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(5,8,16,.96)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        color: '#fff',
        fontFamily: '-apple-system,system-ui,sans-serif',
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600, color: '#3b82f6', letterSpacing: '.04em' }}>
        SafeHaven Receiver
      </h2>
      <p
        style={{
          fontSize: 13,
          color: 'rgba(255,255,255,.55)',
          textAlign: 'center',
          maxWidth: 320,
          lineHeight: 1.5,
        }}
      >
        Paste the invite token from the sender device to start receiving the live stream.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="invite token"
          autoComplete="off"
          spellCheck={false}
          style={{
            background: 'rgba(255,255,255,.07)',
            border: '1px solid rgba(255,255,255,.15)',
            color: '#fff',
            padding: '11px 14px',
            borderRadius: 10,
            fontSize: 13,
            width: 240,
            outline: 'none',
            fontFamily: 'ui-monospace,Menlo,monospace',
          }}
        />
        <button
          onClick={submit}
          style={{
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            padding: '11px 18px',
            borderRadius: 10,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}
