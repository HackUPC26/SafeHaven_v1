/**
 * incidentState.ts — the receiver's incident model + React hook.
 *
 * Ports the legacy `useIncidentState` to TypeScript and folds in the v1
 * enrichments. It is the single reducer that all signals flow through:
 *   - product events (live + the relay's ordered replay on join, §7) via
 *     translateEvent → IncidentEntry → addEntry().
 *   - media liveness (first video frame, staleness) set by the App from the
 *     videoDecoder controller.
 *
 * Derived state (verbatim semantics from legacy):
 *   - riskLevel: tier >= 3 → 'HIGH', tier >= 1 → 'MED', else 'LOW'.
 *   - alertMode: tier >= 3.
 *
 * v1 additions:
 *   - GPS TRAIL history (gpsTrail) for the movement polyline on the map.
 *   - real trigger surfaced in the incident-log subtitle, plus a 'hold' label.
 *   - incident_closed {duration_ms}.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AI_LABEL_MAP, ALERT_AUDIO_LABELS } from './labelMap';

// ── Internal entry shapes produced by translateEvent ──────────────────────

export type Trigger = 'hold' | 'codeword' | 'ai_auto' | 'manual';

export type IncidentEntry =
  | { type: 'incident_start'; ts: number; personName: string | null; synthesized: boolean }
  | { type: 'tier_change'; ts: number; fromTier: number; toTier: number; trigger: Trigger }
  | {
      type: 'gps';
      ts: number;
      lat: number;
      lng: number;
      accuracy: number | null;
      speed: number | null;
      heading: number | null;
      altitude: number | null;
      address: string | null;
    }
  | {
      type: 'ai_label';
      ts: number;
      label: string;
      confidence: number;
      source: string;
      rawIdentifier: string | null;
    }
  | { type: 'incident_end'; ts: number; durationMs: number };

// ── UI-facing view models ──────────────────────────────────────────────────

export interface SessionInfo {
  personName: string;
  startTs: number;
}

export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  altitude: number | null;
  address: string | null;
  ts: number;
}

export interface AudioLabelRow {
  time: string; // HH:MM:SS
  eventType: string; // key of theme.typeColor
  label: string; // human-readable
  conf: number; // 0..100
}

export type LogDot = 'red' | 'amber' | 'grey' | 'blue';

export interface LogRow {
  ts: number;
  label: string;
  sub: string | null;
  dot: LogDot;
}

export type RiskLevel = 'HIGH' | 'MED' | 'LOW';

export interface IncidentState {
  connected: boolean;
  session: SessionInfo | null;
  tier: number;
  gps: GpsFix | null;
  /** Movement trail — chronological list of fixes since session open. */
  gpsTrail: GpsFix[];
  audioLabels: AudioLabelRow[];
  incidentLog: LogRow[];
  videoFrozen: boolean;
  staleSecs: number;
  elapsed: number;
  riskLevel: RiskLevel;
  alertMode: boolean;
  // imperative API used by the transport layer / App
  addEntry: (entry: IncidentEntry) => void;
  setConnected: (v: boolean) => void;
  setVideoLive: (live: boolean) => void;
  setStaleSecs: (n: number) => void;
  reset: () => void;
}

/** HH:MM:SS in 24h, matching legacy tsToTime. */
export function tsToTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Human label for a trigger in the incident log subtitle (incl. 'hold'). */
const TRIGGER_LABELS: Record<Trigger, string> = {
  hold: 'Hold trigger',
  codeword: 'Codeword trigger',
  ai_auto: 'AI auto-trigger',
  manual: 'Manual trigger',
};

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 — audio active',
  2: 'Tier 2 — video active',
  3: 'Emergency — Tier 3',
};
const TIER_DOTS: Record<number, LogDot> = { 1: 'amber', 2: 'amber', 3: 'red' };

/**
 * useIncidentState — ports legacy `useIncidentState`. Single source of truth
 * for the dashboard. All entries (live and replayed) go through `addEntry`.
 */
export function useIncidentState(): IncidentState {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [tier, setTier] = useState(0);
  const [gps, setGps] = useState<GpsFix | null>(null);
  const [gpsTrail, setGpsTrail] = useState<GpsFix[]>([]);
  const [audioLabels, setAudioLabels] = useState<AudioLabelRow[]>([]);
  const [incidentLog, setIncidentLog] = useState<LogRow[]>([]);
  const [videoFrozen, setVideoFrozen] = useState(true);
  const [staleSecs, setStaleSecs] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const pushLog = useCallback((entry: LogRow) => {
    // Newest-first, capped (legacy kept 100).
    setIncidentLog((log) => [entry, ...log].slice(0, 100));
  }, []);

  const addEntry = useCallback(
    (entry: IncidentEntry) => {
      switch (entry.type) {
        case 'incident_start': {
          setConnected(true);
          // A real name wins; the synthesized fallback shows a neutral label.
          const name = entry.personName ?? 'Protected person';
          setSession((prev) =>
            // Keep the original startTs if we already opened (e.g. a synthesized
            // session that a real incident_start later names).
            prev ? { ...prev, personName: name } : { personName: name, startTs: entry.ts },
          );
          pushLog({
            ts: entry.ts,
            label: 'Session started',
            sub: entry.personName ?? null,
            dot: 'grey',
          });
          break;
        }

        case 'tier_change': {
          setTier(entry.toTier);
          pushLog({
            ts: entry.ts,
            label: TIER_LABELS[entry.toTier] ?? `Tier ${entry.toTier}`,
            sub: TRIGGER_LABELS[entry.trigger] ?? entry.trigger,
            dot: TIER_DOTS[entry.toTier] ?? 'grey',
          });
          break;
        }

        case 'gps': {
          const fix: GpsFix = {
            lat: entry.lat,
            lng: entry.lng,
            accuracy: entry.accuracy,
            speed: entry.speed,
            heading: entry.heading,
            altitude: entry.altitude,
            address: entry.address,
            ts: entry.ts,
          };
          setGps(fix);
          // Append to the movement trail (chronological). Cap to keep the SVG
          // polyline light on a long incident.
          setGpsTrail((trail) => {
            const next = [...trail, fix];
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
          pushLog({
            ts: entry.ts,
            label: 'Location update',
            sub:
              entry.address ||
              `${entry.lat.toFixed(4)}° N  ${entry.lng.toFixed(4)}° E`,
            dot: 'blue',
          });
          break;
        }

        case 'ai_label': {
          const mapped = AI_LABEL_MAP[entry.label] ?? { label: entry.label, eventType: 'speech' };
          const conf = Math.round(entry.confidence * 100);
          setAudioLabels((prev) =>
            [
              { time: tsToTime(entry.ts), eventType: mapped.eventType, label: mapped.label, conf },
              ...prev,
            ].slice(0, 30),
          );
          // Only alerting labels reach the incident-log timeline (legacy).
          if (ALERT_AUDIO_LABELS.has(entry.label)) {
            pushLog({
              ts: entry.ts,
              label: mapped.label,
              sub: `AI audio — ${conf}% confidence`,
              dot: conf >= 85 ? 'red' : 'amber',
            });
          }
          break;
        }

        case 'incident_end': {
          pushLog({
            ts: entry.ts,
            label: 'Session ended',
            sub: `Duration: ${Math.round(entry.durationMs / 1000)}s`,
            dot: 'grey',
          });
          break;
        }

        default:
          break;
      }
    },
    [pushLog],
  );

  const setVideoLive = useCallback((live: boolean) => {
    setVideoFrozen(!live);
  }, []);

  const reset = useCallback(() => {
    setConnected(false);
    setSession(null);
    setTier(0);
    setGps(null);
    setGpsTrail([]);
    setAudioLabels([]);
    setIncidentLog([]);
    setVideoFrozen(true);
    setStaleSecs(0);
    setElapsed(0);
  }, []);

  // Session elapsed timer (legacy). Ticks while a session is open.
  const startTs = session?.startTs ?? null;
  useEffect(() => {
    if (startTs == null) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTs) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startTs]);

  const riskLevel: RiskLevel = tier >= 3 ? 'HIGH' : tier >= 1 ? 'MED' : 'LOW';
  const alertMode = tier >= 3;

  // Avoid re-creating the returned object identity unnecessarily.
  return useMemo<IncidentState>(
    () => ({
      connected,
      session,
      tier,
      gps,
      gpsTrail,
      audioLabels,
      incidentLog,
      videoFrozen,
      staleSecs,
      elapsed,
      riskLevel,
      alertMode,
      addEntry,
      setConnected,
      setVideoLive,
      setStaleSecs,
      reset,
    }),
    [
      connected,
      session,
      tier,
      gps,
      gpsTrail,
      audioLabels,
      incidentLog,
      videoFrozen,
      staleSecs,
      elapsed,
      riskLevel,
      alertMode,
      addEntry,
      setVideoLive,
      reset,
    ],
  );
}
