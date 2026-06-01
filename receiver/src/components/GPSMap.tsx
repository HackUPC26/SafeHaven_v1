/**
 * GPSMap.tsx — self-contained, privacy-preserving location view.
 *
 * The legacy map pinned a hard-coded center. v1 requirement: project the real
 * lat/lng of each fix RELATIVE TO THE FIRST FIX onto the existing stylized SVG
 * grid, draw a MOVEMENT TRAIL polyline through the fixes, and a moving pin at
 * the latest fix. Deliberately NO external map tiles (Google/OSM/Mapbox): the
 * whole thing is a local SVG so a worried contact's view never leaks the
 * protected person's coordinates to a third-party tile server.
 *
 * Projection: equirectangular around the first fix. Δx scales by
 * cos(lat0) so east/west isn't exaggerated at higher latitudes. The scene is
 * auto-fit to the bounding box of the trail (with padding), so movement is
 * always visible regardless of absolute scale. With a single fix we just center
 * the pin (no trail yet).
 *
 * Color: blue in monitoring, red in alertMode (RED reserved for alert).
 */

import { useMemo } from 'react';
import type { GpsFix } from '../events/incidentState';

const VIEW_W = 362;
const VIEW_H = 270;
const PAD = 44; // inner padding so the pin/trail never touch the edge.

interface GPSMapProps {
  gps: GpsFix | null;
  /** Chronological trail of fixes since session open. */
  gpsTrail: GpsFix[];
  alertMode: boolean;
}

/** Approx meters per degree latitude (good enough for a relative city-scale view). */
const M_PER_DEG_LAT = 111_320;

export function GPSMap({ gps, gpsTrail, alertMode }: GPSMapProps) {
  const ac = alertMode ? '#ff3b5c' : '#3b82f6';
  const hasFix = !!gps;

  // Stylized block grid (verbatim geometry from legacy).
  const blocks = useMemo(() => {
    const arr: JSX.Element[] = [];
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 11; c++) {
        const x = 28 + c * 34;
        const y = 28 + r * 34;
        const C = 5;
        const w = 26;
        const h = 26;
        const pts = [
          [x + C, y],
          [x + w - C, y],
          [x + w, y + C],
          [x + w, y + h - C],
          [x + w - C, y + h],
          [x + C, y + h],
          [x, y + h - C],
          [x, y + C],
        ]
          .map((p) => p.join(','))
          .join(' ');
        arr.push(
          <polygon key={`${r}-${c}`} points={pts} fill="#0e1b2b" stroke="#172438" strokeWidth="0.8" />,
        );
      }
    }
    return arr;
  }, []);

  /**
   * Project the trail (and current fix) into SVG coordinates relative to the
   * first fix, auto-fit to the bounding box. Returns screen-space points and
   * the latest pin position.
   */
  const projection = useMemo(() => {
    if (!gps) return null;
    // Use the trail if present, else just the single current fix.
    const fixes = gpsTrail.length > 0 ? gpsTrail : [gps];
    const origin = fixes[0]!;
    const lat0Rad = (origin.lat * Math.PI) / 180;
    const cosLat0 = Math.cos(lat0Rad);

    // Convert each fix to local meters east/north relative to origin.
    const local = fixes.map((f) => ({
      east: (f.lng - origin.lng) * M_PER_DEG_LAT * cosLat0,
      // North is up; SVG y grows downward, so we negate when mapping to screen.
      north: (f.lat - origin.lat) * M_PER_DEG_LAT,
    }));

    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const p of local) {
      if (p.east < minE) minE = p.east;
      if (p.east > maxE) maxE = p.east;
      if (p.north < minN) minN = p.north;
      if (p.north > maxN) maxN = p.north;
    }
    // Guard a degenerate (single point / no spread): give it a small span so
    // the pin lands in the middle rather than dividing by zero.
    const spanE = Math.max(maxE - minE, 1);
    const spanN = Math.max(maxN - minN, 1);
    // Uniform scale to preserve aspect; fit the larger span.
    const usableW = VIEW_W - PAD * 2;
    const usableH = VIEW_H - PAD * 2;
    const scale = Math.min(usableW / spanE, usableH / spanN);

    // Center the box within the usable area.
    const offsetX = PAD + (usableW - spanE * scale) / 2;
    const offsetY = PAD + (usableH - spanN * scale) / 2;

    const toScreen = (east: number, north: number) => ({
      x: offsetX + (east - minE) * scale,
      // invert north for screen-y
      y: offsetY + (maxN - north) * scale,
    });

    const screenPts = local.map((p) => toScreen(p.east, p.north));
    const last = screenPts[screenPts.length - 1]!;
    return { screenPts, pin: last };
  }, [gps, gpsTrail]);

  const polyline =
    projection && projection.screenPts.length > 1
      ? projection.screenPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      : null;

  const pinX = projection ? projection.pin.x : VIEW_W / 2;
  const pinY = projection ? projection.pin.y : VIEW_H / 2;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" style={{ display: 'block' }}>
        <rect width={VIEW_W} height={VIEW_H} fill="#091420" />
        {/* stylized roads (verbatim from legacy) */}
        {[38, 72, 106, 140, 174, 208, 242].map((y, i) => (
          <line
            key={`h${i}`}
            x1="0"
            y1={y}
            x2={VIEW_W}
            y2={y}
            stroke={i === 3 ? '#1e3060' : '#111f35'}
            strokeWidth={i === 3 ? 5 : 3}
          />
        ))}
        {[28, 62, 96, 130, 164, 198, 232, 266, 300, 334].map((x, i) => (
          <line
            key={`v${i}`}
            x1={x}
            y1="0"
            x2={x}
            y2={VIEW_H}
            stroke={i === 5 ? '#1e3060' : '#111f35'}
            strokeWidth={i === 5 ? 5 : 3}
          />
        ))}
        <line x1="0" y1="70" x2={VIEW_W} y2="210" stroke="#1a2a50" strokeWidth="6" />
        {blocks}

        {/* ── movement trail polyline ── */}
        {polyline && (
          <polyline
            points={polyline}
            fill="none"
            stroke={ac}
            strokeWidth="2.5"
            strokeOpacity="0.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="1 6"
          />
        )}
        {/* faint solid under-stroke for the trail to read as a path */}
        {polyline && (
          <polyline
            points={polyline}
            fill="none"
            stroke={ac}
            strokeWidth="1"
            strokeOpacity="0.35"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {/* small dots at each historical fix */}
        {projection &&
          projection.screenPts.slice(0, -1).map((p, i) => (
            <circle key={`t${i}`} cx={p.x} cy={p.y} r="2.2" fill={ac} fillOpacity="0.45" />
          ))}

        {/* ── moving pin at the latest fix ── */}
        {hasFix && (
          <>
            {/* pulse ring(s) */}
            <circle cx={pinX} cy={pinY} r="10" fill="none" stroke={ac} strokeWidth="1.5">
              <animate attributeName="r" values="10;28" dur="1.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" values=".7;0" dur="1.4s" repeatCount="indefinite" />
            </circle>
            {alertMode && (
              <circle cx={pinX} cy={pinY} r="10" fill="none" stroke={ac} strokeWidth="1.5">
                <animate attributeName="r" values="10;28" dur="1.4s" begin=".5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values=".7;0" dur="1.4s" begin=".5s" repeatCount="indefinite" />
              </circle>
            )}
            {/* accuracy halo */}
            <circle
              cx={pinX}
              cy={pinY}
              r="22"
              fill={alertMode ? 'rgba(255,59,92,.06)' : 'rgba(59,130,246,.07)'}
              stroke={alertMode ? 'rgba(255,59,92,.25)' : 'rgba(59,130,246,.2)'}
              strokeWidth="1"
            />
            {/* the pin */}
            <circle
              cx={pinX}
              cy={pinY}
              r="6"
              fill={ac}
              stroke={alertMode ? '#ff8099' : '#93c5fd'}
              strokeWidth="2"
            />
            {/* coord tag — clamp x so it stays on-canvas near the right edge */}
            <rect
              x={Math.min(pinX + 12, VIEW_W - 152)}
              y={Math.max(pinY - 20, 2)}
              width="150"
              height="16"
              rx="3"
              fill="rgba(5,12,24,.9)"
            />
            <text
              x={Math.min(pinX + 16, VIEW_W - 148)}
              y={Math.max(pinY - 8, 14)}
              fontSize="8"
              fill={alertMode ? '#ff8099' : '#6eaaff'}
              fontFamily="monospace"
            >
              {gps!.lat.toFixed(4)}° N {gps!.lng.toFixed(4)}° E
            </text>
          </>
        )}

        {!hasFix && (
          <text
            x={VIEW_W / 2}
            y={VIEW_H / 2}
            fontSize="11"
            fill="rgba(255,255,255,.2)"
            fontFamily="monospace"
            textAnchor="middle"
          >
            Awaiting GPS fix…
          </text>
        )}

        <defs>
          <radialGradient id="vig" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(5,10,20,.5)" />
          </radialGradient>
        </defs>
        <rect width={VIEW_W} height={VIEW_H} fill="url(#vig)" />
      </svg>

      {/* address / accuracy chip (verbatim from legacy) */}
      {hasFix && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            background: 'rgba(5,10,20,.9)',
            borderRadius: 8,
            padding: '6px 10px',
            border: `1px solid ${alertMode ? 'rgba(255,59,92,.4)' : 'rgba(59,130,246,.3)'}`,
          }}
        >
          <div style={{ color: alertMode ? '#ff8099' : '#93c5fd', fontSize: 11, fontWeight: 600 }}>
            {alertMode ? '⚠ ' : '📍 '}
            {gps!.address || `${gps!.lat.toFixed(4)}° N, ${gps!.lng.toFixed(4)}° E`}
          </div>
          <div
            style={{
              color: 'rgba(255,255,255,.35)',
              fontSize: 10,
              marginTop: 1,
              fontFamily: 'monospace',
            }}
          >
            ±{gps!.accuracy != null ? `${gps!.accuracy.toFixed(0)} m` : '— m'}
          </div>
        </div>
      )}
    </div>
  );
}
