import type { ClockSample } from '../session/session.js';

/**
 * Estimates the wall-clock time (ms) at which gameTime was 0, using the median
 * of all samples to ignore outliers caused by slow HTTP responses.
 */
export function estimateGameStart(samples: ClockSample[]): number | undefined {
  if (samples.length === 0) return undefined;
  const starts = samples.map((s) => s.wallMs - s.gameTimeS * 1000).sort((a, b) => a - b);
  const mid = Math.floor(starts.length / 2);
  return starts.length % 2 ? starts[mid]! : (starts[mid - 1]! + starts[mid]!) / 2;
}
