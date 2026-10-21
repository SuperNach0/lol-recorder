import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One continuous stretch of speech from one Discord user. */
export interface Segment {
  userId: string;
  /** Wall-clock time (ms since epoch) of the segment's first audio frame. */
  startWallMs: number;
  durationMs: number;
  /** File name relative to the session folder. */
  file: string;
}

export interface Speaker {
  userId: string;
  displayName: string;
}

/** Pairs of (wall clock, in-game time) sampled from the Live Client Data API. */
export interface ClockSample {
  wallMs: number;
  gameTimeS: number;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  guildId?: string;
  channelId?: string;
  gameId?: number;
  /** Wall-clock time (ms since epoch) at which gameTime was 0. */
  gameStartWallMs?: number;
  clockSamples: ClockSample[];
  speakers: Record<string, Speaker>;
  segments: Segment[];
}

export const SESSION_FILE = 'session.json';

export function newSessionId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export async function createSession(root: string, init: Partial<SessionMeta> = {}): Promise<{ dir: string; meta: SessionMeta }> {
  const meta: SessionMeta = {
    id: newSessionId(),
    createdAt: new Date().toISOString(),
    clockSamples: [],
    speakers: {},
    segments: [],
    ...init,
  };
  const dir = join(root, meta.id);
  await mkdir(dir, { recursive: true });
  await saveSession(dir, meta);
  return { dir, meta };
}

export async function saveSession(dir: string, meta: SessionMeta): Promise<void> {
  await writeFile(join(dir, SESSION_FILE), JSON.stringify(meta, null, 2));
}

export async function loadSession(dir: string): Promise<SessionMeta> {
  return JSON.parse(await readFile(join(dir, SESSION_FILE), 'utf8')) as SessionMeta;
}

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
