/**
 * Dev-only latency logging — so the PERCEIVED wait (tap Valider → champs) is measurable
 * without a profiler. You can't say "c'est plus rapide" without a number (see
 * docs/LATENCY-REVIEW.md §6). Pure `formatLatency` (tested) + a `__DEV__`-gated emitter
 * that never adds noise to production logs.
 */

declare const __DEV__: boolean;

/** Render a structured latency line, e.g. "[latency] review wait_ms=1235ms status=extracted". */
export function formatLatency(event: string, spans: Record<string, number | string>): string {
  const parts = Object.entries(spans)
    .map(([k, v]) => (typeof v === 'number' ? `${k}=${Math.round(v)}ms` : `${k}=${v}`))
    .join(' ');
  return `[latency] ${event} ${parts}`;
}

/** Emit a latency line in dev builds only. */
export function logLatency(event: string, spans: Record<string, number | string>): void {
  if (!__DEV__) return;
  // eslint-disable-next-line no-console
  console.log(formatLatency(event, spans));
}
