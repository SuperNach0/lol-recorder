import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { localJson, loopbackAgent } from './local-https.js';

/** Connection info for the League Client (LCU), read from its lockfile. */
export interface LcuCredentials {
  port: number;
  password: string;
}

export const DEFAULT_LOCKFILE = 'C:\\Riot Games\\League of Legends\\lockfile';

/** Lockfile format: `LeagueClient:<pid>:<port>:<password>:https`. */
export function parseLockfile(content: string): LcuCredentials {
  const parts = content.trim().split(':');
  if (parts.length < 5) throw new Error(`Unexpected lockfile content: ${content}`);
  const port = Number(parts[2]);
  if (!Number.isInteger(port)) throw new Error(`Invalid port in lockfile: ${parts[2]}`);
  return { port, password: parts[3]! };
}

export async function readLockfile(path = process.env.LOL_LOCKFILE ?? DEFAULT_LOCKFILE): Promise<LcuCredentials> {
  return parseLockfile(await readFile(path, 'utf8'));
}

export type GameflowPhase =
  | 'None' | 'Lobby' | 'Matchmaking' | 'ReadyCheck' | 'ChampSelect' | 'GameStart'
  | 'InProgress' | 'Reconnect' | 'WaitingForStats' | 'PreEndOfGame' | 'EndOfGame' | string;

export interface ReplayMetadata {
  gameId: number;
  /** e.g. "download", "downloading", "watch", "incompatible", "missingOrExpired", "checking". */
  state: string;
  downloadProgress: number;
}

const REPLAY_BODY = { componentType: 'replay-button_match-history' };

export class LcuClient extends EventEmitter {
  private ws: WebSocket | undefined;

  constructor(private readonly creds: LcuCredentials) {
    super();
  }

  get<T>(path: string): Promise<T> {
    return localJson<T>({ port: this.creds.port, path, auth: `riot:${this.creds.password}` });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return localJson<T>({ port: this.creds.port, path, method: 'POST', body, auth: `riot:${this.creds.password}` });
  }

  gameflowPhase(): Promise<GameflowPhase> {
    return this.get<GameflowPhase>('/lol-gameflow/v1/gameflow-phase');
  }

  async currentGameId(): Promise<number | undefined> {
    const session = await this.get<{ gameData?: { gameId?: number } }>('/lol-gameflow/v1/session');
    return session.gameData?.gameId || undefined;
  }

  replayMetadata(gameId: number): Promise<ReplayMetadata> {
    return this.get<ReplayMetadata>(`/lol-replays/v1/metadata/${gameId}`);
  }

  downloadReplay(gameId: number): Promise<void> {
    return this.post(`/lol-replays/v1/rofls/${gameId}/download`, REPLAY_BODY);
  }

  watchReplay(gameId: number): Promise<void> {
    return this.post(`/lol-replays/v1/rofls/${gameId}/watch`, REPLAY_BODY);
  }

  replaysFolder(): Promise<string> {
    return this.get<string>('/lol-replays/v1/rofls/path');
  }

  /** Emits `gameflow-phase` events with the new phase. */
  connectEvents(): Promise<void> {
    const ws = new WebSocket(`wss://127.0.0.1:${this.creds.port}/`, 'wamp', {
      agent: loopbackAgent,
      headers: { Authorization: `Basic ${Buffer.from(`riot:${this.creds.password}`).toString('base64')}` },
    });
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as [number, string, { uri: string; data: unknown }];
      if (msg[0] !== 8) return;
      const event = msg[2];
      if (event.uri === '/lol-gameflow/v1/gameflow-phase') this.emit('gameflow-phase', event.data as GameflowPhase);
    });
    ws.on('close', () => this.emit('close'));
    ws.on('error', (err) => this.emit('error', err));
    return new Promise((resolve, reject) => {
      ws.once('open', () => {
        ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase']));
        resolve();
      });
      ws.once('error', reject);
    });
  }

  close(): void {
    this.ws?.close();
  }
}
