/**
 * theme.ts — SafeHaven receiver palette and shared color maps.
 *
 * Warm / protective palette, ported verbatim from the legacy single-file
 * dashboard (SafeHaven/receiver/index.html) and the v2 styling reference.
 * RED (#ff3b5c) is RESERVED for HIGH risk / alert state and the Call-Police
 * action only — never used as a generic accent.
 */

export const COLORS = {
  /** App background — deep midnight. */
  bg: '#050810',
  /** Active accent — amber. The default "something is happening" tone. */
  amber: '#f59e0b',
  /** Reserved for HIGH risk / alert + the Call-Police footer ONLY. */
  red: '#ff3b5c',
  /** Monitoring / connected-healthy green. */
  green: '#00d064',
  /** Informational blue (speech, GPS, default pills). */
  blue: '#3b82f6',
  /** Idle video corner brackets — cyan. */
  cyan: '#22d3ee',
} as const;

/**
 * typeColor — audio-event dot/label tint by internal eventType.
 * Ported verbatim from the legacy AudioPanel.
 *   impact  -> red    (alerting impacts: screaming, loud impact, glass, etc.)
 *   shout   -> amber  (raised voice)
 *   silence -> slate  (extended silence)
 *   speech  -> blue   (normal speech / fallback)
 */
export const typeColor: Record<string, string> = {
  impact: '#ff3b5c',
  shout: '#f59e0b',
  silence: '#475569',
  speech: '#3b82f6',
};

/**
 * DOT_COLOR — incident-log timeline dot tint by named class.
 * Ported verbatim from the legacy IncidentLog.
 */
export const DOT_COLOR: Record<string, string> = {
  red: '#ff3b5c',
  amber: '#f59e0b',
  grey: '#475569',
  blue: '#3b82f6',
};
