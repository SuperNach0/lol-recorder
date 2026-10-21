import type { Segment, SessionMeta } from './session.js';

/** Converts a wall-clock time to in-game seconds (negative before the game starts). */
export function wallToGameTime(meta: SessionMeta, wallMs: number): number {
  if (meta.gameStartWallMs === undefined) throw new Error('Session has no game clock');
  return (wallMs - meta.gameStartWallMs) / 1000;
}

export interface ActiveSegment {
  segment: Segment;
  /** Where to seek inside the segment's audio file, in seconds. */
  offsetS: number;
}

/** Segments that should be audible at in-game time `gameTimeS`. */
export function activeSegments(meta: SessionMeta, gameTimeS: number): ActiveSegment[] {
  const result: ActiveSegment[] = [];
  for (const segment of meta.segments) {
    const startS = wallToGameTime(meta, segment.startWallMs);
    const offsetS = gameTimeS - startS;
    if (offsetS >= 0 && offsetS < segment.durationMs / 1000) result.push({ segment, offsetS });
  }
  return result;
}
