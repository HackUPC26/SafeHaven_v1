/**
 * translateEvent.ts — wire product events → internal incident entries.
 *
 * Ported from the legacy receiver's `translateEvent` (SafeHaven/receiver/
 * index.html). The wire shapes are the ratified PROTOCOL §5.1 events; this
 * module maps their snake_case keys to the camelCase internal `IncidentEntry`
 * shape that incidentState.ts consumes — exactly as the legacy code did, with
 * the v1 enrichments wired in.
 *
 * Key behaviors carried over / required by the contract:
 *   - tsOf(): read `timestamp_iso` (ISO-8601 UTC), fall back to wall-clock now.
 *   - Open the session from a REAL `incident_start` (person_name); KEEP the
 *     defensive "synthesize a session on first signal" fallback if it was
 *     missed (§5.2).
 *   - Read the REAL `trigger` (PROTOCOL §5.1), defaulting to 'codeword' only if
 *     absent (legacy back-compat).
 *   - Consume the enriched GPS fields (accuracy/speed/heading/altitude/address).
 *   - `incident_opened` is HOLD-only, fired from Tier 0 → trigger:'hold'.
 *   - `incident_closed` carries `duration_ms`.
 *
 * Stateful note: a sender reconnect/new session sends a fresh `incident_start`,
 * which resets the synthesize-once latch. The relay also clears its event log
 * on a fresh `incident_start` (§7), so a replayed timeline begins cleanly.
 */

import type { IncidentEntry, Trigger } from './incidentState';

/** The wire `trigger` enum (PROTOCOL §5.1). */
const VALID_TRIGGERS: ReadonlySet<string> = new Set(['hold', 'codeword', 'ai_auto', 'manual']);

/** Read `timestamp_iso` → epoch millis; fall back to current wall clock. */
export function tsOf(payload: { timestamp_iso?: unknown } | null | undefined): number {
  const iso = payload && typeof payload.timestamp_iso === 'string' ? payload.timestamp_iso : null;
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

/** Coerce an unknown to a finite number, or null. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a wire trigger; default to 'codeword' if absent/invalid (legacy). */
function triggerOf(v: unknown, fallback: Trigger = 'codeword'): Trigger {
  return typeof v === 'string' && VALID_TRIGGERS.has(v) ? (v as Trigger) : fallback;
}

/**
 * The mutable bit of cross-event context translateEvent needs: the last tier
 * (to compute fromTier on a change) and whether a session has been opened (to
 * drive the synthesize-once fallback). The caller owns this so it survives the
 * relay's ordered replay of the full event log on join.
 */
export interface TranslateContext {
  lastTier: number;
  sessionOpened: boolean;
}

export function makeContext(): TranslateContext {
  return { lastTier: 0, sessionOpened: false };
}

/**
 * Translate one wire event payload (the inner object of {type:"event"}) into
 * zero or more internal IncidentEntry values. Returns [] for unknown events so
 * the caller can blindly spread the result.
 *
 * `ctx` is mutated in place (lastTier / sessionOpened) to mirror the legacy
 * module-scoped state, but scoped to a connection so reconnects start clean.
 */
export function translateEvent(
  payload: Record<string, unknown>,
  ctx: TranslateContext,
): IncidentEntry[] {
  if (!payload) return [];
  const ts = tsOf(payload as { timestamp_iso?: unknown });
  const t = payload['event_type'];
  const out: IncidentEntry[] = [];

  // Defensive session synthesis (§5.2): if any signal arrives before a real
  // incident_start, open a placeholder session so the dashboard wakes up. A
  // real incident_start later still re-opens with the true name.
  const ensureSession = (personName?: string): void => {
    if (ctx.sessionOpened) return;
    ctx.sessionOpened = true;
    out.push({
      type: 'incident_start',
      ts,
      // Name unknown over the wire in the fallback path; the caller derives a
      // token-prefixed tag (it knows the token; translateEvent does not).
      personName: personName ?? null,
      synthesized: !personName,
    });
  };

  switch (t) {
    case 'incident_start': {
      // REAL session open with the configured display name (§5.2). This is the
      // normal path and also (re)opens after a fresh session.
      const personName =
        typeof payload['person_name'] === 'string' ? (payload['person_name'] as string) : null;
      const tier = num(payload['tier']);
      const trigger = triggerOf(payload['trigger'], 'hold');
      ctx.sessionOpened = true;
      out.push({ type: 'incident_start', ts, personName, synthesized: false });
      // incident_start also carries the opening tier; reflect it if > 0.
      if (tier != null && tier > 0) {
        out.push({ type: 'tier_change', ts, fromTier: ctx.lastTier, toTier: tier, trigger });
        ctx.lastTier = tier;
      }
      break;
    }

    case 'incident_opened': {
      // HOLD only, from Tier 0 (§5.1). Defaults to tier 1, trigger 'hold'.
      ensureSession();
      const toTier = num(payload['tier']) ?? 1;
      // Dedup: incident_start already carries the opening tier, so an
      // incident_opened to the SAME tier would emit a redundant log row. Only
      // record a real transition (fromTier !== toTier).
      if (toTier !== ctx.lastTier) {
        out.push({ type: 'tier_change', ts, fromTier: ctx.lastTier, toTier, trigger: 'hold' });
        ctx.lastTier = toTier;
      }
      break;
    }

    case 'tier_changed': {
      ensureSession();
      const toTier = num(payload['tier']) ?? ctx.lastTier;
      const trigger = triggerOf(payload['trigger']); // real trigger, else 'codeword'.
      // Dedup redundant no-op tier rows (e.g. incident_start{tier:1} immediately
      // followed by tier_changed{tier:1}); only record a real transition.
      if (toTier !== ctx.lastTier) {
        out.push({ type: 'tier_change', ts, fromTier: ctx.lastTier, toTier, trigger });
        ctx.lastTier = toTier;
      }
      break;
    }

    case 'gps_update': {
      ensureSession();
      const lat = num(payload['lat']);
      const lng = num(payload['lng']);
      if (lat == null || lng == null) break; // a fix without coords is useless.
      out.push({
        type: 'gps',
        ts,
        lat,
        lng,
        accuracy: num(payload['accuracy']),
        speed: num(payload['speed']),
        heading: num(payload['heading']),
        altitude: num(payload['altitude']),
        address: typeof payload['address'] === 'string' ? (payload['address'] as string) : null,
      });
      break;
    }

    case 'ai_label': {
      ensureSession();
      const rawConf = num(payload['confidence']) ?? 0;
      // confidence is clamped to [0,1] on the wire (§5.3); clamp again defensively.
      const confidence = Math.max(0, Math.min(1, rawConf));
      out.push({
        type: 'ai_label',
        ts,
        label: typeof payload['label'] === 'string' ? (payload['label'] as string) : 'UNKNOWN',
        confidence,
        source:
          typeof payload['source'] === 'string' ? (payload['source'] as string) : 'SoundAnalysis',
        rawIdentifier:
          typeof payload['raw_identifier'] === 'string'
            ? (payload['raw_identifier'] as string)
            : null,
      });
      break;
    }

    case 'incident_closed': {
      const durationMs = num(payload['duration_ms']) ?? 0;
      out.push({ type: 'incident_end', ts, durationMs });
      // Allow a subsequent fresh incident_start to re-open cleanly.
      ctx.sessionOpened = false;
      ctx.lastTier = 0;
      break;
    }

    default:
      // Unknown / future event types are ignored (older-reader-forward-compat).
      break;
  }

  return out;
}
