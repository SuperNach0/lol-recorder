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

/** What the end-of-game screen showed, for the session list. */
export interface GameSummary {
  championName?: string;
  win?: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  queueType?: string;
  gameLengthS?: number;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  endedAt?: string;
  guildId?: string;
  channelId?: string;
  channelName?: string;
  gameId?: number;
  game?: GameSummary;
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

export { activeSegments, wallToGameTime, type ActiveSegment } from './timeline.js';
