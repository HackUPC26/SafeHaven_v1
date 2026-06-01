/**
 * labelMap.ts — AI label presentation, ported verbatim from the legacy
 * receiver (SafeHaven/receiver/index.html).
 *
 * The 8 valid wire labels (PROTOCOL §5.3) plus a SPEECH_NORMAL fallback are
 * mapped to a human-readable string and an internal `eventType` that drives
 * the dot/label color (see theme.ts `typeColor`). ALERT_AUDIO_LABELS is the
 * subset that escalates into the incident log.
 *
 * NOTE: this is purely presentation. The wire/source of truth for which labels
 * exist is the sender's on-device SoundAnalysis mapping (PROTOCOL §5.3); the
 * receiver only formats whatever `label` arrives.
 */

/** Internal event class used for coloring (keys of theme.typeColor). */
export type AudioEventType = 'impact' | 'shout' | 'silence' | 'speech';

export interface LabelInfo {
  label: string;
  eventType: AudioEventType;
}

/**
 * AI_LABEL_MAP — the 8 protocol labels + a SPEECH_NORMAL fallback. Ported from
 * the legacy receiver, with one deliberate change: there is no `GUNSHOT` label —
 * SafeHaven does not claim firearm detection. Apple's gunshot_gunfire acoustic
 * class is folded into IMPACT (a loud impact) on the sender (PROTOCOL §5.3).
 * Unknown labels fall back to {label: <raw>, eventType: 'speech'} at the call
 * site (see translateEvent), matching legacy behavior.
 */
export const AI_LABEL_MAP: Record<string, LabelInfo> = {
  SHOUTING: { label: 'Raised voice detected', eventType: 'shout' },
  SCREAMING: { label: 'Screaming detected', eventType: 'impact' },
  CRYING: { label: 'Crying detected', eventType: 'impact' },
  IMPACT: { label: 'Loud impact detected', eventType: 'impact' },
  SLAP: { label: 'Slap sound detected', eventType: 'impact' },
  DOOR_SLAM: { label: 'Door slam detected', eventType: 'impact' },
  GLASS_BREAKING: { label: 'Glass breaking', eventType: 'impact' },
  EXTENDED_SILENCE: { label: 'Extended silence', eventType: 'silence' },
  SPEECH_NORMAL: { label: 'Normal speech', eventType: 'speech' },
};

/**
 * ALERT_AUDIO_LABELS — labels pushed to the incident-log timeline
 * (EXTENDED_SILENCE / SPEECH_NORMAL are not alerts).
 */
export const ALERT_AUDIO_LABELS: ReadonlySet<string> = new Set([
  'SHOUTING',
  'SCREAMING',
  'CRYING',
  'IMPACT',
  'SLAP',
  'DOOR_SLAM',
  'GLASS_BREAKING',
]);
