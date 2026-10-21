import { localJson } from './local-https.js';

/** The game process (live or replay) serves its APIs on this port. */
export const GAME_PORT = 2999;

export interface GameStats {
  gameMode: string;
  gameTime: number;
  mapName: string;
}

/** Live Client Data API: only answers while a game (or replay) is running. */
export function getGameStats(): Promise<GameStats> {
  return localJson<GameStats>({ port: GAME_PORT, path: '/liveclientdata/gamestats', timeoutMs: 1000 });
}

export interface Playback {
  /** Current replay time in seconds. */
  time: number;
  /** Total replay length in seconds. */
  length: number;
  paused: boolean;
  seeking: boolean;
  speed: number;
}

/**
 * Replay API: requires `EnableReplayApi=1` under `[General]` in
 * `Config\game.cfg` of the League install.
 */
export function getPlayback(): Promise<Playback> {
  return localJson<Playback>({ port: GAME_PORT, path: '/replay/playback', timeoutMs: 1000 });
}

export function setPlayback(change: Partial<Pick<Playback, 'time' | 'paused' | 'speed'>>): Promise<Playback> {
  return localJson<Playback>({ port: GAME_PORT, path: '/replay/playback', method: 'POST', body: change, timeoutMs: 1000 });
}

/** Samples the in-game time, timestamped at the midpoint of the request. */
export async function sampleGameClock(): Promise<{ wallMs: number; gameTimeS: number }> {
  const sent = Date.now();
  const stats = await getGameStats();
  const received = Date.now();
  return { wallMs: (sent + received) / 2, gameTimeS: stats.gameTime };
}
